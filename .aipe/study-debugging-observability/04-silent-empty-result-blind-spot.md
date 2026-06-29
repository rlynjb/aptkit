# The silent empty-result blind spot

*Industry names: missing-signal blind spot · the "success that returned nothing" anti-pattern · unobserved degraded path. Type: project-specific (a gap in `search_knowledge_base`).*

## Zoom out — where this lives

This file is about an event that *isn't* emitted. The whole observability spine (`01`) makes behavior visible by turning it into events — but it can only show what someone chose to emit. There's one boundary where the most important signal is missing: when retrieval returns zero hits, the system says nothing.

```
  Zoom out — the one boundary that stays silent

  ┌─ Service: retrieval (packages/retrieval) ──────────────────────────┐
  │  search_knowledge_base handler                                     │
  │  search-knowledge-base-tool.ts:78-96                               │
  │    pipeline.query() ─► hits ─► (filter) ─► return { results }      │
  │                                  │                                 │
  │                       ★ if hits is [] → return [] silently ★       │ ← the gap
  │                          NO trace.emit({type:'warning'})           │
  └───────────────────────────┬────────────────────────────────────────┘
                              │ tool result flows back to the loop
  ┌─ Runtime: runAgentLoop ───▼────────────────────────────────────────┐
  │  records tool_call_end{ result: {results:[]} }  — looks normal     │
  └───────────────────────────────────────────────────────────────────────┘
```

## Zoom in — what it is

A zero-hit search is a *degraded success*: the call succeeded (no error), but it returned nothing useful. The tool emits no `warning` event for it (`search-knowledge-base-tool.ts:89-92`), so the trace shows a normal `tool_call_end` with an empty array. Studio's summary counts "Warnings: 0" (`02`); the durable trajectory shows `results: []` with no flag (`03`). The question this *should* answer but doesn't: *did retrieval actually find anything, or did it quietly come up empty?*

This is the contributing condition behind the war story (`03`): the hallucinated filter zeroed the results, and because zero results are silent, nothing in the trace pointed at the problem — the diagnosis had to come from reading the *args*, not from any emitted alarm.

## How it works — the gap, then the one-line fix

### Move 1 — the mental model

You know this failure from frontend work: a `fetch()` that returns `200 OK` with an empty `[]` body, and your list component renders blank with no error. The request "succeeded," so your `.catch()` never fires and your error state never shows — the user just sees nothing, and you have no log saying why. A zero-hit retrieval is exactly that: a successful call with an empty payload, on the happy path, invisible to every error-shaped observer.

```
  The anti-pattern — degraded success on the happy path

   call ──► success (no throw) ──► payload is empty []
                                        │
            error observers ──X─────────┘  (nothing fired)
            warning stream  ──X─────────┘  (nothing emitted)
                                        ▼
                          looks healthy, is degraded
```

### Move 2 — the walkthrough

**Where the silence happens.** The handler returns whatever the pipeline gives, empty or not (`search-knowledge-base-tool.ts:78-96`):

```ts
const handler: ToolHandler = async (args) => {
  const topK = Math.max(requestedTopK, minTopK);
  const fetchK = filter ? topK * 4 : topK;
  let hits = await pipeline.query(query, fetchK);
  if (filter) hits = hits.filter((hit) => matchesFilter(hit, filter)).slice(0, topK);
  return { query, results: hits.map(toResult) };   // hits === [] returns { results: [] } — no signal
};
```

There's no branch on `hits.length === 0`. The empty case is indistinguishable, to any observer, from a deliberate "nothing matched."

**Why the existing guards don't catch it.** The codebase already hardened *two* causes of empty results — but neither *announces* the emptiness:

- `minTopK` (`:51`) stops a weak model from asking for too few results.
- `matchesFilter` (`:101-106`) stops a hallucinated filter from wiping hits.

Both reduce the *likelihood* of zero hits. Neither *emits* anything when zero hits happen anyway — e.g. a genuinely empty corpus, or an embedding so far from everything that cosine similarity ranks nothing useful. The degraded path is still silent.

**Why the summary lies.** Studio's `summarizeTrace` counts warnings from `warning`+`error` events only (`components.tsx:415`). No emit, no count. So a run that retrieved nothing shows:

```
  Trace summary on a zero-hit run

  Turns 2 · Tools 1 · Warnings 0 · Tokens 600 · 410ms
                       ▲
                       └─ reads as healthy; retrieval found nothing
```

Green panel, broken run. That false-green is the cost of the missing event.

### Move 2.5 — current state vs the unbuilt fix

This is built-but-incomplete, so the fix is worth drawing as Phase A → Phase B.

```
  Phase A (now)                        Phase B (the unbuilt fix)
  ─────────────                        ─────────────────────────
  handler returns {results:[]}         if (hits.length === 0)
  no event emitted                       trace.emit({ type:'warning',
  Studio: Warnings 0                       capabilityId,
  trajectory: results:[] (unflagged)       message:`zero hits for "${query}"`
  diagnosis: read args by hand             + filter context, timestamp })
                                         then return {results:[]}
                                       Studio: Warnings 1 ► triage tab lights up
                                       trajectory: a warning row before the empty result
```

The fix is one `emit`. The cost of *not* having it is the entire war-story diagnosis: instead of the trace surfacing "zero hits, here's the filter that caused it," an engineer had to read tool args backward by hand (`03`). What doesn't change: the tool's contract, its return shape, every caller. It's purely additive observability — the strongest kind of fix, because nothing downstream has to migrate.

One wiring note: the tool handler doesn't currently receive the `trace` sink (it's a `ToolHandler` over the pipeline, `:78`). So the honest fix is slightly more than one line — either thread the sink into the handler, or emit the warning one layer up in the loop when a `search_knowledge_base` `tool_call_end` comes back with `results: []`. The loop already has the sink; the loop already inspects the result. That's where this most cheaply lands.

### Move 3 — the principle

**A successful call that returns nothing useful is a failure wearing a success's clothes — instrument it, or it stays invisible.** Error-shaped observability (try/catch, error events, non-200 status) only catches things that *threw*. The degraded-but-successful path slips through every one of those. The general rule: for any operation whose value is "did it find something," emit a signal on the *empty* branch, not just the *thrown* branch. The empty branch is where the silent bugs live.

## Primary diagram

```
  The blind spot and its fix — one missing emit

  ┌─ search_knowledge_base handler (retrieval) ──────────────────────┐
  │  hits = query(); if(filter) hits = hits.filter(matchesFilter)    │
  │                                                                  │
  │  ── Phase A ──►  return { results: hits }      (empty = silent)  │
  │  ── Phase B ──►  if (hits.length === 0)                          │
  │                    emit({type:'warning', message:'zero hits'})   │
  │                  return { results: hits }                        │
  └───────────────────────────┬──────────────────────────────────────┘
                              │
       ┌──────────────────────┼───────────────────────┐
       ▼                      ▼                        ▼
  Studio summary       durable trajectory        diagnosis
  Warnings 0 → 1       +1 warning row before      "read args by hand"
  (triage lights)      the empty result            → "the trace told me"
```

## Elaborate

This is the single most teachable gap in the repo because it sits at the exact intersection of two disciplines: it's an *observability* miss (no event on the degraded path) that caused a *retrieval-quality* failure (`study-ai-engineering` owns the quality side). The reason it's worth a whole file rather than one audit line: it inverts the usual lesson. Most observability advice is "add more logs." Here the lesson is sharper — *you don't need more logs, you need a signal on the one branch nobody instruments: the empty success.*

It also explains why the war story was hard. With the Phase B emit, the diagnosis in `03` would have been a glance — "Warnings: 1, zero hits, filter was `{textContains}`" — instead of a backward read of raw tool args. The fix to the *symptom* (the filter) shipped; the fix to the *blind spot* (the silence that hid it) did not. That's the honest state.

## Interview defense

**Q: Your retrieval works, the agent still answered wrong, and the trace shows no errors. What's the gap?**

The gap is that a zero-hit search is a silent success. The handler returns `{results: []}` with no warning event, so the trace shows a normal tool call and Studio's summary reads "Warnings: 0" — green, but the run is degraded. That's why diagnosing the filter bug required reading tool args by hand instead of seeing a flag.

```
  success (no throw) + empty payload = no signal anywhere
  fix: emit a warning on the hits.length === 0 branch
```

One-line anchor: *instrument the empty-success branch, not just the throw — that's where the silent bugs live.* The fix is additive: one emit, no caller changes.

**Q: Where exactly would you add the emit, given the handler doesn't have the trace sink?**

Two options: thread the sink into the `ToolHandler`, or — cheaper — emit it in `runAgentLoop` when a `search_knowledge_base` `tool_call_end` returns `results: []`, since the loop already holds the sink and already inspects the result. I'd take the loop option: it keeps the retrieval package free of the trace dependency and the signal still lands on the same stream.

## See also

- `03-persisted-trajectory-backward-read.md` — the war story this silence made hard.
- `01-capability-event-trace.md` — the `warning` variant the fix would emit onto.
- `02-trace-replay-as-debugger.md` — the summary that falsely reads green today.
- Cross-guide: `study-ai-engineering` (retrieval quality / precision@k), `study-testing` (the regression guard for the symptom).
