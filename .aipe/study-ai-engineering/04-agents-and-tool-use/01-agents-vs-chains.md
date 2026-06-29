# Agents vs chains

**Subtitle:** Agentic vs deterministic orchestration · who decides the steps · *Industry standard (aptkit runs both)*

## Zoom out, then zoom in

The first decision in any LLM feature is who controls the control flow: you, or
the model. A *chain* is a fixed pipeline — you wrote the steps, the model just
fills the blanks. An *agent* is a loop where the model decides which tool to call
and when to stop. aptkit ships both, and the line between them is a single
question: does a `for` loop over turns exist, and does the model steer it?

```
  Zoom out — two shapes of orchestration in aptkit

  ┌─ Chain (you define the steps) ─────────────────────────────┐
  │  generateStructured: prompt ─► model ─► parse ─► validate   │
  │  fixed, one-shot (+ bounded JSON retry). NO loop, NO tools. │
  └─────────────────────────────────────────────────────────────┘
  ┌─ Agent (the model decides the steps) ──────────────────────┐
  │  ★ runAgentLoop: for turn in 0..maxTurns ★                  │ ← we are here
  │    model picks a tool → run it → feed result back → repeat  │
  │    model decides WHICH tools and HOW MANY turns             │
  └─────────────────────────────────────────────────────────────┘
```

Now zoom in. Both shapes live in `packages/runtime`. The chain is
`generateStructured` (`structured-generation.ts:54`) — one call, parse, validate,
retry once. The agent is `runAgentLoop` (`run-agent-loop.ts:76`) — a real loop
where the model emits `tool_use` blocks and you run them. Same model provider, same
codebase; the difference is entirely *who owns the iteration*.

## Structure pass

**Layers.** Capability (the feature) → orchestration primitive (`generateStructured`
*or* `runAgentLoop`) → model provider → model.

**Axis — control of the steps.** Who decides what runs next? Trace it: in
`generateStructured` the sequence is hard-coded — generate, then parse, then
validate, then maybe one strict-JSON retry (`structured-generation.ts:62`). The
model never chooses a next step; *you* did, in code. In `runAgentLoop` the model
emits `tool_use` blocks and the loop runs whatever it named (`run-agent-loop.ts:139`),
so the step sequence is decided at runtime by the model. The axis "is the next
step in the code or in the model's output?" is the whole distinction.

**Seam.** The choice of primitive itself. A capability that calls
`generateStructured` is a chain; one that calls `runAgentLoop` is an agent. The
seam flips at *which function the capability imports* — there is no third thing.

## How it works

### Move 1 — the mental model

You already know this split from frontend work. A chain is a `Promise` chain you
wrote: `fetch().then(parse).then(validate)` — the steps are in your code, the data
just flows through. An agent is an event loop you *don't* fully control: it runs
until a condition you set, but each iteration's work is decided by something else
(the user, or here, the model). Chain = imperative script. Agent = bounded loop
with a model in the driver's seat.

```
  Chain vs agent — where the steps live

  CHAIN (steps in your code)        AGENT (steps in model output)
  ┌──────────────┐                  ┌──────────────────────────┐
  │ step1 (you)  │                  │ for turn in 0..maxTurns:  │
  │   ▼          │                  │   model picks step ◄──┐   │
  │ step2 (you)  │                  │     ▼                 │   │
  │   ▼          │                  │   run tool            │   │
  │ step3 (you)  │                  │     ▼                 │   │
  │   ▼          │                  │   feed result back ───┘   │
  │ done         │                  │   model decides: stop?    │
  └──────────────┘                  └──────────────────────────┘
```

### Move 2 — the two primitives, side by side

**The chain — `generateStructured`.** A chain is a one-shot pass with a bounded
parse/validate retry. No loop over turns, no tools array — the model produces text
once (or twice, on a strict-JSON nudge) and you turn it into a typed value
(`structured-generation.ts:62`):

```ts
for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {   // maxAttempts default 2
  const messages = attempt === 1 ? baseMessages : appendStrictSuffix(baseMessages, strictSuffix);
  response = await options.model.complete({ system, messages, ... });   // no tools
  const parsed = parseValidatedJson(rawText, options.validate);
  if (parsed.ok) return { ok: true, value: parsed.value, ... };          // done — fixed shape
}
```

The loop here is *not* the model deciding steps — it's a retry on a parse failure.
The step sequence (generate → parse → validate → retry) is fully yours. This is the
chain: the anomaly-monitoring scan and the rubric judge both run this way.

```
  Chain — fixed steps, you own every one

  prompt ─► model.complete (no tools) ─► parse JSON ─► validate
                  │                                       │ fail
                  └──────── retry once (+strict suffix) ◄─┘
  the model never names a "next step" — the code does
```

**The agent — `runAgentLoop`.** An agent is a `for` loop over turns where the model
emits `tool_use` blocks and the loop runs them, feeds results back, and lets the
model decide whether to go again (`run-agent-loop.ts:98`):

```ts
for (let turn = 0; turn < maxTurns; turn += 1) {                 // default maxTurns 8
  const response = await model.complete({ system, messages, tools: toolSchemas, ... });
  const toolUses = toolUsesFromContent(response.content);        // what did the MODEL choose?
  if (toolUses.length === 0) { finalText = text; break; }        // model decided to stop
  for (const toolUse of toolUses) {
    const { result } = await tools.callTool(toolUse.name, toolUse.input);  // run model's choice
    toolResults.push({ type: 'tool_result', toolUseId: toolUse.id, content: ... });
  }
  messages.push({ role: 'user', content: toolResults });          // observation → next turn
}
```

The loop bounds the iteration (`maxTurns`), but *which* tool runs and *whether to
continue* are read out of the model's output. That is the agent: the model steers.

```
  Agent — model steers a bounded loop

  turn ► model.complete(tools) ► tool_use blocks?
           ▲                          │ yes        │ none
           │                          ▼            ▼
           └─ result fed back ◄─ callTool      finalText, break
                                 (model's pick)  (model chose to stop)
```

**The fleet.** aptkit has six capabilities split across the two shapes. Four are
agents (the model decides the trajectory); two are chains (you fixed the steps):

```
  The six capabilities, by shape

  AGENTS (runAgentLoop — model decides)        CHAINS (generateStructured — you decide)
  ┌──────────────────────────────────┐         ┌──────────────────────────────────┐
  │ rag-query        maxTurns 6 / 4   │         │ anomaly-monitoring scan           │
  │ query            maxTurns 8 / 6   │         │ rubric judge (in rubric-          │
  │ recommendation   maxTurns 6 / 4   │         │   improvement's eval step)        │
  │ diagnostic-inv.  maxTurns 8 / 6   │         └──────────────────────────────────┘
  │ anomaly-monitor. maxTurns 8 / 6   │
  │ rubric-improve.  maxTurns 6 / 3   │
  └──────────────────────────────────┘
```

(Some capabilities mix both: `anomaly-monitoring` and `rubric-improvement` run an
agent loop *and* a one-shot structured pass for different sub-steps.)

### Move 3 — the principle

Reach for a chain when you know the steps; reach for an agent only when you don't.
Agents cost more — every turn is a model call, and a model that steers can loop,
dead-end, or pick the wrong tool. A chain is cheaper, more predictable, and trivial
to test because the control flow is yours. aptkit's default is the chain
(`generateStructured` for anything with a fixed shape) and it pays for an agent only
where the *number and choice of retrievals genuinely depends on the question* —
rag-query, query, diagnostic, recommendation. The interview signal is refusing to
make everything an agent: most "agent" features are chains that didn't need a loop.

## Primary diagram

```
  Agents vs chains — one codebase, two control flows

  ┌─ Capability ────────────────────────────────────────────────────────┐
  │  imports ONE primitive — that import IS the agent/chain decision      │
  └───────────────┬───────────────────────────────────┬──────────────────┘
                  │                                   │
  ┌─ generateStructured (CHAIN) ──┐   ┌─ runAgentLoop (AGENT) ────────────┐
  │  steps fixed in code:         │   │  for turn in 0..maxTurns:          │
  │   generate → parse → validate │   │    model emits tool_use            │
  │   → retry once (strict JSON)  │   │    run it → feed result back       │
  │  NO loop, NO tools            │   │    model decides stop / continue   │
  │  cheap, predictable, testable │   │  bounded by maxTurns/maxToolCalls  │
  └───────────────────────────────┘   └────────────────────────────────────┘
        anomaly scan, rubric judge        rag-query, query, diagnostic, recommend
```

## Elaborate

The industry framing is "workflows vs agents" (Anthropic's *Building effective
agents* uses exactly this split): workflows are LLM calls orchestrated through
predefined code paths; agents are systems where the LLM directs its own process.
aptkit is a clean instance — the same `ModelProvider` underneath, two orchestration
primitives on top. The subtle bit is that an agent's `for` loop *looks* like a chain
if you only read the runtime: it's bounded, deterministic-ish code. The difference
isn't the loop — it's that the loop body reads its next action out of model output
(`toolUsesFromContent`, `run-agent-loop.ts:131`) instead of from the next line of
your function. Read `03-react-pattern.md` for what those turns actually are
(thought/action/observation), and `06-error-recovery.md` for why an agent needs
bounds a chain doesn't.

## Project exercises

### Convert one over-engineered agent capability to a chain
- **Exercise ID:** —  (no curriculum file in repo)
- **What to build:** take a capability that runs `runAgentLoop` but almost always
  makes exactly one tool call (inspect traces), and rewrite it as a two-step chain
  (one retrieval, then `generateStructured`) — then compare token cost and latency.
- **Why it earns its place:** the most common agent mistake is using a loop where a
  line would do; proving a capability didn't need the loop, with numbers, is the
  staff-level judgment call.
- **Files to touch:** the chosen agent under `packages/agents/*/src/`,
  `packages/runtime/src/structured-generation.ts` (reference), the agent's `test/`.
- **Done when:** the rewritten capability passes the same eval set with fewer model
  calls per question and a tighter p95 latency.
- **Estimated effort:** `1–4hr`

### Add a `shape` field to the trace so agent vs chain is visible
- **Exercise ID:** —  (no curriculum file in repo)
- **What to build:** emit a trace event at capability start tagging it `agent` or
  `chain` (and for agents, the observed turn count), so Studio can show the split.
- **Why it earns its place:** making the control-flow shape observable turns "is
  this an agent?" from a code-reading question into a dashboard fact — useful for
  cost attribution.
- **Files to touch:** `packages/runtime/src/events.ts`,
  `packages/runtime/src/run-agent-loop.ts`,
  `packages/runtime/src/structured-generation.ts`.
- **Done when:** a Studio trace shows `shape: agent, turns: 3` for rag-query and
  `shape: chain` for the anomaly scan.
- **Estimated effort:** `1–4hr`

## Interview defense

**Q: "When do you use an agent vs a fixed chain?"**
A chain when I know the steps, an agent only when the number and choice of steps
depends on the input. In aptkit, anything with a fixed output shape — the anomaly
scan, the rubric judge — runs `generateStructured`: generate, parse, validate, one
strict retry, done. The four retrieval/analytics capabilities run `runAgentLoop`
because how many searches a question needs isn't knowable upfront, so the model
decides. The default is the chain; the agent is the exception you pay for.

```
  steps known?  ─yes─► chain (generateStructured) — cheap, predictable
                ─no──► agent (runAgentLoop)        — model steers, bounded
```
Anchor: *don't make it an agent unless the model needs to choose the steps.*

**Q: "Both your chain and your agent have a loop. What makes one an agent?"**
The chain's loop is a parse-retry — the step sequence (generate → parse → validate)
is in my code; the loop only re-runs the same step on a JSON failure. The agent's
loop reads its next action *out of the model's output*: `toolUsesFromContent` pulls
the `tool_use` blocks the model emitted, and the loop runs whatever the model named.
The model owning the next step is what makes it an agent, not the presence of a loop.

```
  chain loop: retry the SAME step you coded
  agent loop: run the NEXT step the MODEL chose
```
Anchor: *agent = the loop body's next action comes from model output, not your code.*

## See also

- `02-tool-calling.md` — how the agent's tool_use blocks are produced
- `03-react-pattern.md` — what a single agent turn actually is
- `04-tool-routing.md` — which tools an agent is even allowed to choose
- `06-error-recovery.md` — the bounds an agent needs that a chain doesn't
- `05-evals-and-observability/01-eval-set-types.md` — testing each shape
