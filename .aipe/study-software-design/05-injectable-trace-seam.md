# 05 — Injectable Trace Seam

**Subtitle:** Deep interface + dependency injection · one `emit()` method, body
chosen by the host — *Industry standard* (the sink / observer seam). **This file
also names the honest weakness: the seam is clean but wired twice.**

---

## Zoom out, then zoom in

The agent loop produces a running commentary — every step, tool call, token
count, warning — as a stream of typed events. But the loop must not care *where*
those events go: console, memory, NDJSON over the wire, a Postgres table. So it
emits to a one-method interface and lets whoever runs it supply the body.

```
  Zoom out — the trace seam between producer and consumer

  ┌─ Producer (runtime) ─────────────────────────────────────────┐
  │  runAgentLoop · generateStructured · fallback · context guard │
  │  all call trace?.emit(event)                                   │
  └────────────────────────────┬───────────────────────────────────┘
                               │ ★ CapabilityTraceSink.emit() ★   ← we are here
  ┌─ Consumer (host-chosen, INJECTED) ─▼────────────────────────────┐
  │  in-memory array (apps/studio/vite.config.ts:540)               │
  │  SupabaseTraceSink (in buffr — a DIFFERENT repo)                │
  │  [no reference sink shipped by aptkit]                          │
  └──────────────────────────────────────────────────────────────────┘
```

Zoom in: the concept is a **deep, injectable interface** — one method,
`emit(event)`, with the actual destination supplied by the caller as a
dependency. The same seam idea appears on the Gemma provider's `chat` transport
(`gemma-provider.ts:19`) — inject a recorded transport in tests, the real HTTP
one in production. The question it answers: how does the runtime produce
observability without owning a database, a file format, or a UI?

---

## Structure pass

- **Layers:** producer (loop) → the `CapabilityTraceSink` interface → the
  injected body.
- **Axis — "who decides where events go?":** trace it.
  - producer → **doesn't decide.** It calls `trace?.emit(...)` and moves on
    (`run-agent-loop.ts:112, 128, 147, 171`).
  - interface → decides nothing; it's one method (`events.ts:26-28`).
  - injected body → **decides everything.** Push to an array? Insert a Postgres
    row? That choice lives entirely in the host.
- **Seam:** `emit()`. Control over destination flips from "none" (producer) to
  "total" (host). A load-bearing seam — it's also the **test** seam (inject a
  collecting sink, assert on the events) and the **substitution** seam.

But here's the weakness the structure pass exposes: the seam is crossed by
**two independent bodies in two repos**, and aptkit ships neither a reference
implementation nor a shared one. The seam is correct; the wiring is doubled.

---

## How it works

### Move 1 — the mental model

You know the observer pattern from the DOM: `addEventListener` lets the element
emit `click` events without knowing what any listener does. `CapabilityTraceSink`
is that with one event method — the loop "fires" events, the sink "listens." And
because the sink is *injected* (passed in, not imported), it's also a seam you
swap in tests, exactly like passing a mock `fetch`.

```
  Pattern — fan-in to one emit(), body chosen downstream

   runAgentLoop ──┐
   structuredGen ─┤  all call ──► trace?.emit(event)
   fallback ──────┤                     │
   contextGuard ──┘                     ▼
                            ┌─ CapabilityTraceSink ─┐
                            │   emit(event): void    │   ← one method
                            └───────────┬────────────┘
                       injected ┌───────┴────────┐ injected
                                ▼                ▼
                       in-memory array     SupabaseTraceSink
                       (Studio)            (buffr — other repo)
```

The strategy: **a discriminated-union event type + a one-method sink + `?.`
optionality = full observability with zero coupling to a destination.**

### Move 2 — the step-by-step walkthrough

**The event type and the sink, in full.** The event is a discriminated union;
the sink is one method.

```ts
// packages/runtime/src/events.ts:1-28 (condensed)
export type CapabilityEvent =
  | { type: 'step';            capabilityId; role; content; timestamp }
  | { type: 'tool_call_start'; capabilityId; toolName; args; timestamp }
  | { type: 'tool_call_end';   capabilityId; toolName; result?; error?; durationMs; timestamp }
  | { type: 'model_usage';     capabilityId; provider; model; inputTokens?; outputTokens?; ... }
  | { type: 'warning';         capabilityId; message; timestamp }
  | { type: 'error';           capabilityId; message; timestamp };

export type CapabilityTraceSink = { emit(event: CapabilityEvent): void; };
```

The union is the *contract richness* — six event shapes the producer can emit and
any sink must accept. The sink interface is one method. That asymmetry (rich
events, trivial sink) is what makes the seam deep: a sink author writes one
`emit` and gets all six event types for free.

**The producer fires and forgets.** The loop never branches on what the sink
does — it emits with optional chaining so a missing sink is a silent no-op:

```ts
// packages/runtime/src/run-agent-loop.ts:112, 147, 171 (condensed)
trace?.emit({ type: 'model_usage', capabilityId, provider: model.id, ... });
// ...
trace?.emit({ type: 'tool_call_start', capabilityId, toolName: toolUse.name, ... });
// ...
trace?.emit({ type: 'tool_call_end', capabilityId, durationMs: ..., ... });
```

The `?.` is load-bearing: it makes tracing *opt-in* without an if-guard at every
call site. No sink → no overhead, no special case.

**Body A — the in-memory sink (Studio).** Studio just wants the events in an
array to render a replay:

```ts
// apps/studio/vite.config.ts:539-545 (condensed)
const trace: CapabilityEvent[] = [];
const traceSink = {
  emit: (event: CapabilityEvent) => { trace.push(event); },
};
const model = createModelProvider(fixture, mode, traceSink);
```

**Body B — `SupabaseTraceSink` (buffr, a different repo).** buffr wants the events
durable, so its `emit` inserts rows:

```ts
// /Users/rein/Public/buffr/src/supabase-trace-sink.ts:49 (paraphrase — buffr repo)
export class SupabaseTraceSink implements CapabilityTraceSink {
  emit(event: CapabilityEvent) { /* INSERT into the agents schema, keyed by conversationId */ }
}
```

Both satisfy the same interface. Neither knows the other exists. The producer is
identical for both.

### Move 2.5 — the honest weakness (current vs better state)

This is the seam the prompt asked to name bluntly. The interface is right; the
*ecosystem around it* hardened late.

```
  Comparison — what's true now vs the move

  NOW                                  BETTER
  ───────────────────────────────────  ───────────────────────────────────
  in-memory sink defined inline in     a CollectingTraceSink shipped in
  Studio's vite.config.ts:540          @aptkit/runtime, reused by Studio,
                                       tests, and anyone else
  SupabaseTraceSink lives in buffr,    (buffr's durable sink still lives in
  wired separately, unknown to aptkit  buffr — that's correct; it's app-specific)
  no NDJSON sink in runtime even       an NdjsonTraceSink in runtime (the
  though ndjson-stream.ts exists       streaming helper is already there)
  → two bodies, two repos, no shared   → one reference body, the rest compose
    reference. observability seam is      on it. seam unchanged.
    duplicated by accident
```

What does NOT have to change: the `CapabilityTraceSink` interface and every
`trace?.emit(...)` call site. The fix is purely *additive* — ship reference
sinks in `@aptkit/runtime` so the in-memory and NDJSON bodies aren't reinvented
per host. That the seam can absorb this fix without touching the producer is
itself proof the interface was drawn right; it's the *packaging* that lagged.

### Move 3 — the principle

A one-method injected interface is the cheapest way to decouple a producer from
every possible consumer — but a clean seam doesn't automatically give you a
*shared* implementation. The interface being correct (provable: two unrelated
bodies satisfy it, the producer never changed) is separate from the
implementations being *consolidated*. aptkit nailed the first and is still owed
the second.

---

## Primary diagram

```
  Injectable trace seam — full picture (incl. the doubled wiring)

  ┌─ runtime producers ───────────────────────────────────────────────┐
  │ runAgentLoop · generateStructured · fallback · contextGuard        │
  │ all: trace?.emit(CapabilityEvent)   (?. = opt-in, no special case) │
  └────────────────────────────┬───────────────────────────────────────┘
  ═══════════════ THE SEAM — CapabilityTraceSink.emit() (events.ts:26) ═══
  ═══════════════ rich 6-variant event union, 1-method sink ════════════
                               │ injected body, host's choice
        ┌──────────────────────┼───────────────────────────┐
        ▼                      ▼                            ▼
  in-memory array      SupabaseTraceSink            [missing: a runtime
  (Studio,             (buffr, OTHER REPO,           reference sink — would
   vite.config:540)     wired independently)         dedupe the in-memory body)
        └──── same producer, two bodies, no shared reference ────┘  ← the weakness
```

---

## Elaborate

This is the observer/sink seam plus dependency injection — the most reused
decoupling move there is. It shows up here for the usual reason: the runtime is a
*library* (it ships as `@rlynjb/aptkit-core`), and a library must not pick your
database or your log format. Emitting to an injected sink is how it stays
deployment-agnostic — which is the entire reason aptkit and buffr are separate
repos (`context.md`: "aptkit stays deployment-agnostic; buffr fills the slots").

The same seam recurs on the Gemma `chat` transport (`gemma-provider.ts:19`) and
implicitly anywhere the runtime takes a dependency instead of importing one. When
you see a one-method type with optional chaining at the call sites, that's this
pattern. The lesson the weakness teaches: drawing the seam and *populating* it
with shared reference bodies are two separate jobs — do both, or you get
accidental duplication across hosts.

---

## Interview defense

**Q: How does the agent loop produce observability without owning a log
destination?**

It emits typed events to a one-method `CapabilityTraceSink` that's injected by the
host. The producer calls `trace?.emit(event)` — optional chaining makes tracing
opt-in with no per-call guard — and the host supplies the body: an in-memory
array in Studio, a Supabase-row inserter in buffr. The producer code is identical
for every destination.

```
  loop ──► emit(event) ──► [ host's sink: array | Postgres | NDJSON ]
           (producer never branches on destination)
```

**Q: Is there anything weak about how it's wired?**

Yes — the seam is clean but the bodies are duplicated across repos with no shared
reference. Studio hand-rolls an in-memory sink inline; buffr has its own
`SupabaseTraceSink`; aptkit ships neither a `CollectingTraceSink` nor an
`NdjsonTraceSink` even though the NDJSON streaming helper already exists in the
runtime. The fix is additive — ship reference sinks in `@aptkit/runtime` — and
notably *doesn't touch the interface or any call site*, which is the proof the
seam itself was drawn correctly.

*Anchor:* "One-method injected sink, optional-chained at the call sites — the
producer never knows the destination. The interface is right; the missing piece
is a shared reference body so hosts stop reinventing the in-memory sink."

---

## See also

- `01-deep-provider-module.md` — the same injection move for the `chat` transport.
- `06-capability-as-composition.md` — agents pass `trace` straight through to the
  loop; the `capabilityId` pass-through variable lives here too (audit lens 4).
- `audit.md` — lens 1 (unknown-unknown: the second sink), lens 3 (the cross-repo
  trace leak).
- `../study-testing/` — the injectable sink as the test seam; `../study-debugging
  -observability/` — the trace as the observability backbone.
