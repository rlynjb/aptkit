# LLM observability

**Subtitle:** Traces, spans, and replay · the `CapabilityEvent` union + Studio NDJSON + the usage ledger · *Industry standard (local trace + Studio; no Langfuse/LangSmith)*

## Zoom out, then zoom in

You can't eval what you can't see. Observability is how an agent run becomes
inspectable — what the model did, how long each step took, what it cost — and in
aptkit it's the same recording that the eval backbone replays. There are three
pillars, the same three the field names for any distributed system, specialized
for LLMs.

```
  Zoom out — the three observability pillars in aptkit

  ┌─ TRACES (per request) ────────────────────────────────────┐
  │  ★ CapabilityEvent stream: model_usage, step, tool calls ★ │ events.ts
  ├─ SPANS (sub-steps) ───────────────────────────────────────┤
  │  tool_call_start / tool_call_end with durationMs per tool  │ run-agent-loop.ts
  ├─ REPLAY (re-run a saved trace) ───────────────────────────┤
  │  FixtureModelProvider replays recorded ModelResponse[]     │ fixture-provider.ts
  └────────────────────────────────────────────────────────────┘
       surfaced live in Studio over NDJSON; priced by the usage ledger
```

Now zoom in. The thing to notice is that these aren't three separate systems —
they're three views of one event stream. The trace is the list of
`CapabilityEvent`s; the spans are two of those event *types* with a duration; and
replay is what you get when you record those events and feed the recorded model
responses back through a fake provider. aptkit has no Langfuse, no LangSmith — it's
a local trace plus the Studio dashboard, and that's enough because the trace *is*
the eval artifact.

## Structure pass

**Layers.** The agent loop emits `CapabilityEvent`s into a `CapabilityTraceSink`
(`events.ts:26`) → the trace is collected into a replay artifact and/or streamed
as NDJSON → Studio decodes the stream; the usage ledger sums it into cost.

**Axis — cost.** Trace where token cost is observed. Each model turn emits a
`model_usage` event carrying provider, model, input/output tokens, and an
`estimated` flag (`run-agent-loop.ts:112`). `summarizeUsage` folds every
`model_usage` event in the trace into one ledger row (`usage-ledger.ts:25`), and
`estimateCost` prices it — but *only* for OpenAI gpt-4.1 family
(`usage-ledger.ts:71`); Gemma is local, so it's free. Cost is observed at the
trace and resolved at the ledger.

**Seam.** The `CapabilityTraceSink.emit(event)` interface (`events.ts:26`). On one
side, the agent loop fires events without knowing where they go. On the other, a
collector might buffer them into an artifact, or Studio might serialize them to
NDJSON and stream them to a browser. That one seam is why the same run can be both
recorded for replay *and* watched live, with no change to the loop.

## How it works

### Move 1 — the mental model

This is the same maturity curve you already walked on the backend:
`console.log` → structured logs → distributed tracing. A bare `console.log` is a
string you grep. Structured logs are typed records you can query. Distributed
tracing adds spans with durations and a parent run, so you can see *where the time
went*. aptkit's `CapabilityEvent` union is the structured-log step, and the
`tool_call_start`/`end` pair with `durationMs` is the tracing step.

```
  console.log  ─►  structured logs  ─►  distributed tracing

  "called search"       { type:'tool_call_start',     tool_call_start + tool_call_end
                          toolName, args, timestamp }   with durationMs (a span)
       grep                  query/filter                  see where time went
```

The jump that matters is from string to *typed union*: once an event has a `type`
discriminant and fixed fields, you can sum it (cost), time it (spans), assert on it
(evals), and render it (Studio) — all from the same record.

### Move 2 — the three pillars, concretely

**Pillar 1 — traces (the `CapabilityEvent` union).** A trace is an array of typed
events. The union has six variants (`events.ts:1`):

```ts
export type CapabilityEvent =
  | { type: 'step'; capabilityId; role; content; timestamp }                    // an assistant message
  | { type: 'tool_call_start'; capabilityId; toolName; args; timestamp }        // span open
  | { type: 'tool_call_end'; capabilityId; toolName; result?; error?; durationMs; timestamp } // span close
  | { type: 'model_usage'; capabilityId; provider; model; inputTokens?; outputTokens?; estimated?; timestamp } // cost
  | { type: 'warning'; capabilityId; message; timestamp }
  | { type: 'error'; capabilityId; message; timestamp };
```

Every field is typed and timestamped. That's the whole observability foundation —
not a logging library, just a discriminated union the loop emits.

```
  Pillar 1 — the trace is a typed event stream

  loop emits ─► [ model_usage, step, tool_call_start, tool_call_end, ... ]
                     │ each typed + timestamped
                     ▼
            sum it (cost) · time it (spans) · assert it (eval) · render it (Studio)
```

**Pillar 2 — spans (tool calls with duration).** A span is a sub-step with a
start, an end, and a duration. The loop opens one before each tool call and closes
it after, recording `durationMs` (`run-agent-loop.ts:147` and `:171`):

```ts
trace?.emit({ type: 'tool_call_start', capabilityId, toolName, args, timestamp: timestamp() }); // :147
// ... await tools.callTool(...) returns { result, durationMs } ...
trace?.emit({
  type: 'tool_call_end', capabilityId, toolName,
  result: toolCall.result, error: toolCall.error,
  durationMs: toolCall.durationMs ?? 0,            // how long THIS tool took
  timestamp: timestamp(),
});                                                 // :171
```

Each tool call is one span; the `model_usage` event is the model's "span" carrying
its token cost. Read the trace top to bottom and you have the run's timeline —
which tool ran, how long, in what order.

```
  Pillar 2 — spans bracket each tool call

  tool_call_start(search) ──[ callTool ]──► tool_call_end(search, durationMs: 42)
                              │
                              ▼  the span = the time between start and end
                       where the run spent its time
```

**Pillar 3 — replay (re-run a saved trace).** Replay is observability's payoff:
record a run, then re-run it deterministically — with a different prompt or model,
or just to check nothing regressed. The `FixtureModelProvider` is the entire
mechanism (`fixture-provider.ts:3`): it implements `ModelProvider` but, instead of
calling a model, hands back recorded `ModelResponse[]` in order:

```ts
export class FixtureModelProvider implements ModelProvider {
  constructor(private readonly responses: ModelResponse[]) {}
  async complete(request: ModelRequest): Promise<ModelResponse> {
    this.requests.push(request);
    const response = this.responses[this.index++];
    if (!response) throw new Error(`fixture model exhausted after ${this.index - 1} responses`);
    return response;
  }
}
```

Because it satisfies the same `ModelProvider` seam as Gemma or Claude, the agent
loop can't tell the difference — no network, no tokens, fully deterministic. This
is the same seam from `01-llm-foundations/08-provider-abstraction.md`, repurposed
for observability: the abstraction that lets you swap providers is exactly what
lets you replay a trace.

```
  Pillar 3 — replay swaps the provider, not the loop

  recorded ModelResponse[] ─► FixtureModelProvider.complete() ─► same loop runs
                                  │ no model, no network, deterministic
                                  ▼
                       same trace re-emitted → diff against the baseline
```

**Surfacing it — Studio over NDJSON.** aptkit's "dashboard" is Studio
(`apps/studio`), which consumes the trace as a stream of newline-delimited JSON.
The client decodes it with the runtime's NDJSON helper (`apps/studio/src/api.ts:138`):

```ts
for await (const record of decodeNdjsonStream(responseBodyChunks(response.body))) { ... }
```

Each `CapabilityEvent` is one NDJSON line, so the browser renders steps, tool
spans, and usage as they arrive — and the same Studio surfaces replay runs. No
hosted tracing vendor; the trace streams straight to a local UI.

```
  Surfacing — one event per NDJSON line

  trace events ─► serialize one-per-line ─► HTTP body ─► decodeNdjsonStream ─► Studio renders live
```

### Move 3 — the principle

Make observability one typed event stream and every other capability falls out of
it: spans are two event types with a duration, cost is the sum of one event type,
replay is recording the stream and feeding the model responses back through the
provider seam, and the dashboard is the stream rendered line by line. You don't
need a tracing vendor when the trace is a first-class artifact your evals already
consume. The honest scope: pricing only covers the OpenAI gpt-4.1 family
(`usage-ledger.ts:71`); Gemma is free and anything else returns no estimate.

## Primary diagram

```
  Observability in aptkit — one event stream, four uses

  ┌─ Agent loop (run-agent-loop.ts) ──────────────────────────────────────┐
  │  emit model_usage (:112) · step (:128) · tool_call_start (:147) /      │
  │  tool_call_end + durationMs (:171)                                     │
  └───────────────┬────────────────────────────────────────────────────────┘
                  │ CapabilityTraceSink.emit (events.ts)
                  ▼
        ┌─────────┴───────────┬──────────────────┬─────────────────────┐
        ▼                     ▼                  ▼                     ▼
   TRACE (array)        SPANS (durationMs)   COST                  REPLAY
   typed union          per tool call        summarizeUsage +      FixtureModelProvider
   = eval artifact      = run timeline       estimateCost          re-runs recorded
                                             (OpenAI only; Gemma    ModelResponse[]
                                              free)
        └──────────────── streamed as NDJSON → Studio renders it live ──────┘
```

## Elaborate

The industry vocabulary — traces, spans, metrics — maps cleanly onto aptkit's
event union: a `tool_call_start`/`end` pair is a span, the trace is the request's
span tree flattened, and `summarizeUsage`/`estimateCost` is the metrics layer
(tokens, cost). What's distinctive is that the trace isn't a side-channel for
debugging — it's the *same JSON* that becomes a replay artifact and gets
asserted by `assertReplayArtifactShape` (`01-eval-set-types.md`,
`02-eval-methods.md`). Observability and evals are the same data viewed twice. The
deliberate non-goal is a hosted tracing backend; the bet is that a local trace plus
Studio is enough when the trace is already first-class. The cost gap is worth
naming: only gpt-4.1 pricing is wired in, so a non-OpenAI paid provider would show
`n/a` until you add its rates. Read `01-llm-foundations/06-token-economics.md` for
the ledger in depth and `01-llm-foundations/08-provider-abstraction.md` for the
seam replay rides on.

## Project exercises

### Add a latency span summary to the usage ledger
- **Exercise ID:** —  (no curriculum file in repo)
- **What to build:** a function that folds `tool_call_end` events into a per-tool
  latency summary (total time, slowest tool, call count), alongside the existing
  token `summarizeUsage` — turning the spans already in the trace into a metric.
- **Why it earns its place:** the spans carry `durationMs` but nothing aggregates
  them into "where did the run spend its time"; building that is the metrics
  pillar the trace already has the data for.
- **Files to touch:** `packages/runtime/src/usage-ledger.ts` (or a sibling),
  `packages/runtime/test/`, reading `packages/runtime/src/events.ts`.
- **Done when:** a trace with three tool calls returns a summary naming the slowest
  tool and its total time.
- **Estimated effort:** `1–4hr`

### Add pricing for a second provider family
- **Exercise ID:** —  (no curriculum file in repo)
- **What to build:** extend `pricingForModel` to cover one non-OpenAI paid
  provider (e.g. an Anthropic model family) so its `model_usage` events produce a
  real cost estimate instead of `undefined`.
- **Why it earns its place:** the cost pillar currently prices only gpt-4.1;
  closing it for a second family shows you understand the ledger is
  provider-keyed and where the gap is.
- **Files to touch:** `packages/runtime/src/usage-ledger.ts`,
  `packages/runtime/test/`.
- **Done when:** a `model_usage` event from the new family yields a non-`undefined`
  `CostEstimate` with that family's rates.
- **Estimated effort:** `<1hr`

## Interview defense

**Q: "What does observability look like for your agents, without a tracing vendor?"**
One typed event stream. The loop emits `CapabilityEvent`s — `model_usage` per
model turn, `tool_call_start`/`end` per tool with a `durationMs`, plus
step/warning/error — into a `CapabilityTraceSink`. From that one stream I get
three pillars: the trace (the event array), spans (the tool-call pairs are the run
timeline), and cost (`summarizeUsage` + `estimateCost`). Studio renders it live by
decoding the events as NDJSON. No Langfuse — the trace is a first-class local
artifact.

```
  emit CapabilityEvent[] → trace · spans (durationMs) · cost · NDJSON → Studio
```
Anchor: *one typed event stream; spans, cost, and replay all fall out of it.*

**Q: "How is your observability connected to your evals?"**
They're the same data. The trace I emit for observability is the same JSON that
becomes a replay artifact — `assertReplayArtifactShape` checks its shape, and a
promoted fixture freezes its answer. Replay itself is observability's payoff: the
`FixtureModelProvider` satisfies the same `ModelProvider` seam as a real provider,
so I feed the recorded `ModelResponse[]` back through the loop and re-run
deterministically — no model, no network. The abstraction that lets me swap
providers is exactly what lets me replay a trace.

```
  trace (observe) === replay artifact (eval) ; FixtureModelProvider replays it deterministically
```
Anchor: *the trace is the eval artifact — observe and assert from the same stream.*

## See also

- `01-eval-set-types.md` — the replay artifact this trace becomes
- `02-eval-methods.md` — `assertReplayArtifactShape` over the trace
- `01-llm-foundations/06-token-economics.md` — the usage ledger and OpenAI-only pricing
- `01-llm-foundations/08-provider-abstraction.md` — the `ModelProvider` seam replay rides on
- `04-agents-and-tool-use/06-error-recovery.md` — the loop that emits these events
