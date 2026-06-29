# Trace replay as the dev-time debugger

*Industry names: time-travel debugging · trace viewer · agent-run inspector. Type: project-specific (a React panel over the event stream).*

## Zoom out — where this lives

The trace from `01` is just an array until something reads it. Studio is the dev-time reader: it turns the `CapabilityEvent[]` into a scrollable, filterable, expandable timeline. For development, **this panel IS the debugger** — there's no other tool you'd open to ask "what did the agent just do?"

```
  Zoom out — Studio as the trace's visual reader

  ┌─ Service layer (runtime) ───────────────────────────────────────┐
  │  runAgentLoop emits CapabilityEvent[]   (01)                     │
  └───────────────────────────┬──────────────────────────────────────┘
                              │ array (fixture) or NDJSON stream (live)
  ┌─ UI layer (apps/studio) ──▼──────────────────────────────────────┐
  │  AgentReplayShell  ──► visibleTrace  ──► ★ TracePanel ★          │
  │  AgentReplayShell.tsx:163        components.tsx:131  ← we're here │
  │  summary header · filter tabs · per-event payload (expandable)   │
  └───────────────────────────────────────────────────────────────────┘
```

## Zoom in — what it is

`TracePanel` (`apps/studio/src/components.tsx:131-182`) is a React component that takes `trace: CapabilityEvent[]` and renders it as a debugging surface: a summary strip (turns / tools / warnings / tokens / elapsed), four filter tabs (`all / model / tools / warnings`), and one row per event with an expandable payload. The question it answers: *show me, step by step, what the agent did — and let me click into the arguments and results.*

## How it works

### Move 1 — the mental model

You already know this shape: it's the Network tab in DevTools. A list of entries in time order, a filter to narrow by type, click a row to expand the request/response detail, and a summary bar at the top counting totals. Swap "HTTP request" for "agent event" and you have `TracePanel`.

```
  The pattern — a filtered, expandable event list (DevTools Network tab)

  ┌─ summary: Turns 3 · Tools 2 · Warnings 0 · Tokens 1,240 · 820ms ┐
  ├─ filter:  [all] [model] [tools] [warnings]                       ┤
  ├─ 01  model_usage   gemma/gemma2:9b · 412 tokens                  │
  │  02  step          "I'll search the knowledge base..."           │
  │  03  tool_call_start  search_knowledge_base   ▸ Arguments        │ ◄ click to
  │  04  tool_call_end    search_knowledge_base · 38ms  ▸ Result     │   expand payload
  └──────────────────────────────────────────────────────────────────┘
```

### Move 2 — the walkthrough

**The trace handoff: live vs replay, one variable.** The shell computes which array to render in one line, `AgentReplayShell.tsx:163`:

```ts
const visibleTrace = replay?.trace ?? liveTrace;
```

`liveTrace` accumulates event-by-event as a run streams in (`onEvent` appends, `:115-117`); `replay.trace` is the final settled array. So the *same* panel renders a run as it streams AND the finished result — no second code path. The boundary condition: a stale run's events must not bleed into a new run, which is why `onEvent` checks `runCounter.current === nextRunId` before appending (`:116`) — a run-id guard against out-of-order async.

```
  Layers-and-hops — how a live event reaches the panel

  ┌─ buffr/runtime ─┐ hop1: emit(event)   ┌─ Vite middleware ─┐
  │  runAgentLoop   │ ──────────────────► │  NDJSON stream    │
  └─────────────────┘                     └─────────┬─────────┘
                                          hop2: line │ (decodeNdjsonStream)
  ┌─ UI: AgentReplayShell ─────────────────────────▼──────────┐
  │  onEvent(e) → setLiveTrace([...current, e])  (run-id guard)│
  │  visibleTrace = replay?.trace ?? liveTrace  ─► TracePanel  │
  └────────────────────────────────────────────────────────────┘
```

**Branching on `event.type` to render each row.** `TraceItem` (`components.tsx:310-338`) is where the discriminated union pays off — it narrows on `type` to build a one-line detail:

```ts
const detail =
  event.type === 'model_usage'   ? `${event.provider}/${event.model} · ${tokens} tokens`
  : event.type === 'tool_call_start' ? `${event.toolName}`
  : event.type === 'tool_call_end'   ? `${event.toolName} · ${event.durationMs}ms`
  : event.type === 'step'            ? event.content.slice(0, 120)
  : 'message' in event ? event.message : '';
```

TypeScript narrows each branch so `event.durationMs` is only reachable inside the `tool_call_end` arm. The union from `01` isn't just storage discipline — it's what makes this renderer total and type-safe.

**The expandable payload — where you actually debug.** `tracePayload` (`:428-434`) decides what to put behind the click-to-expand `<details>`:

```ts
if (event.type === 'tool_call_start') return { label: 'Arguments', value: formatPayload(event.args) };
if (event.type === 'tool_call_end' && event.result !== undefined) return { label: 'Result', value: ... };
if (event.type === 'tool_call_end' && event.error) return { label: 'Error', value: event.error };
```

This is the load-bearing line for debugging. **The expandable `Arguments` on `tool_call_start` is where you'd *see* a hallucinated filter** — the same `{textContains: ...}` that caused the war story is visible here, one click deep, in any run. The visual debugger surfaces the cause; you don't have to go to Postgres for a dev-time look.

**The summary and the filter — triage before detail.** `summarizeTrace` (`:404-419`) folds the array into counts (turns from `model_usage`, tools from `tool_call_start`, warnings from `warning`+`error`, tokens summed, elapsed from min/max timestamp). `traceFilterMatches` (`:421-426`) narrows the list. Together they're the triage move: glance at "Warnings: 2," click the `warnings` tab, read the two. The boundary condition: **a clean run shows "Warnings: 0," which looks like health but can hide the silent-empty-result bug** — there's no event to count, so the summary is falsely green. That's the bridge to `04`.

### Move 3 — the principle

**The cheapest debugger is the one that reads the data you already have.** aptkit didn't build a debugger; it built an event stream (`01`) and then a thin React view over it. Because the events are typed and serializable, the view is ~300 lines and type-safe by construction. The general move: if your system's behavior is already a value, the "debugger" is just a renderer — and you get it almost for free.

## Primary diagram

```
  TracePanel — the dev-time debugger over CapabilityEvent[]

  ┌─ apps/studio/src/components.tsx ──────────────────────────────────┐
  │ TracePanel({ trace })                                             │
  │   summarizeTrace(trace)  ─► summary strip (turns/tools/warn/tok)  │
  │   filter state           ─► traceFilterMatches() ─► visibleTrace  │
  │   visibleTrace.map ─► TraceItem                                   │
  │        ├─ detail line   (switch on event.type, :312)             │
  │        └─ <details> payload (tracePayload, :428)                 │
  │             tool_call_start ─► Arguments  ◄── the hallucinated    │
  │             tool_call_end   ─► Result | Error    filter shows here│
  └────────────────────────────────────────────────────────────────────┘
   source: AgentReplayShell visibleTrace = replay?.trace ?? liveTrace (:163)
```

## Elaborate

This is "time-travel debugging" in the Redux DevTools sense — step through a recorded sequence of typed actions and inspect state at each — minus the state reconstruction (aptkit inspects the events themselves, not a derived state tree). It works *because* of the design choice in `01`: behavior as a value. Compare to a console-log debugger, where you'd be scrolling a terminal, re-running to add more prints, and reconstructing order by eye. Here the order is the array, the detail is one click, and re-running is deterministic (`05`).

The honest limit: this debugger only shows what was emitted. It is blind to anything that didn't become an event — most importantly the zero-hit retrieval (`04`). A debugger over an event stream is exactly as good as the stream's coverage.

## Interview defense

**Q: How do you debug an agent run during development?**

Studio's `TracePanel` renders the `CapabilityEvent[]` as a DevTools-Network-tab-style timeline: summary counts up top, filter by event type, click any row to expand the payload. For a tool call I expand `Arguments` to see exactly what the model passed — which is how I'd catch a model passing a bad filter or a wrong query.

```
  summary ─► filter tab ─► row ─► expand payload (args / result / error)
```

One-line anchor: *the debugger is a ~300-line renderer over the event stream — the data was already a value, so the view came almost free.*

**Q: What can this debugger NOT show you?**

Anything that wasn't emitted. The summary's "Warnings: 0" reads as healthy, but a retrieval that returned zero hits emits no event — so a real failure can show a green panel. The fix isn't in the panel; it's emitting the missing event upstream (`04`). A trace viewer is only as good as the trace's coverage.

## See also

- `01-capability-event-trace.md` — the stream this renders.
- `04-silent-empty-result-blind-spot.md` — the failure this panel can't show.
- `05-deterministic-replay-reproduction.md` — why "re-run" is reliable here.
- Cross-guide: `study-frontend-engineering` owns the React/Vite mechanics; this file reads the panel only as an observability surface.
