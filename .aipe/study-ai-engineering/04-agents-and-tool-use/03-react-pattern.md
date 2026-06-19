# The bounded agent loop (ReAct + budget + forced synthesis)

**Industry names:** ReAct (Reason + Act), tool-use loop, agentic loop · *Industry standard*

## Zoom out, then zoom in

Every agent in AptKit — query, anomaly-monitoring, diagnostic, recommendation,
rubric-improvement — is the same engine with a different prompt and a different
tool allowlist. That engine is `runAgentLoop`. Here's where it sits.

```
  Zoom out — where the agent loop lives

  ┌─ Agent layer (packages/agents/*) ───────────────────────────┐
  │  RecommendationAgent.propose()  builds system + tool schemas │
  └───────────────────────────────┬──────────────────────────────┘
                                   │  calls
  ┌─ Runtime layer (packages/runtime) ─▼──────────────────────────┐
  │   ★ runAgentLoop()  ←── THIS CONCEPT                          │
  │     loops: model.complete → run tools → feed results back     │
  └───────────────────────────────┬──────────────────────────────┘
                                   │  ModelProvider.complete()
  ┌─ Provider layer ───────────────▼──────────────────────────────┐
  │  anthropic / openai / fixture — returns text + tool_use blocks │
  └────────────────────────────────────────────────────────────────┘
```

Zoom in: a **chain** is steps you hard-code. An **agent** is a loop where the
*model* decides each step and how many — but a raw "loop until the model stops"
is a foot-gun (it loops forever, burns tokens, or never produces a parseable
answer). AptKit's loop is the ReAct pattern with three guardrails bolted on:
a turn budget, a tool-call budget, and a forced synthesis turn. That's the
concept.

## Structure pass

**Layers.** Two: the *outer* agent (sets the budget, owns the prompt and the
allowlist) and the *inner* loop (runs turns until the model stops or the budget
runs out).

**Axis — who decides control flow?** The outer agent decides the *bounds*
(`maxTurns`, `maxToolCalls`). Inside the bounds, the *model* decides each move.
On the last turn, control flips back to *code*: the tools are yanked away and
the model is forced to answer.

**Seams.** The load-bearing seam is the `forceFinal` boundary inside the loop —
that single boolean is where control flips from "LLM free to query" to "code
compels an answer." Get that seam wrong and the agent either loops to the budget
ceiling every time or stops one query short of an answer.

## How it works

You already know the shape from a `fetch()` retry loop: you try, you check a
condition, you either continue or break. The agent loop is that, but each
iteration is a full model round-trip, and the "condition" is *did the model ask
to use a tool?*

### Move 1 — the mental model

```
  The ReAct loop — Thought / Action / Observation

  ┌─────────────┐
  │  Thought    │ ← model reads context, decides next move
  └──────┬──────┘
         │ emits a tool_use block?
    ┌────┴────┐
    │   yes   │ no ─────────────► finalText = its text, BREAK
    ▼
  ┌─────────────┐
  │   Action    │ ← code runs the tool (model can't run it itself)
  └──────┬──────┘
         ▼
  ┌─────────────┐
  │ Observation │ ← tool result fed back as the next user message
  └──────┬──────┘
         └──────────► loop, UNLESS budget spent → force final answer
```

The model is the brain; your code is the hands. The brain says "call
`get_metric_timeseries`"; the loop runs it and hands the result back. The model
never executes anything itself.

### Move 2 — the load-bearing skeleton

This concept has a kernel. Strip it to the minimum that's still the pattern:

```
  Kernel (pseudocode)

  messages = [user prompt]
  for turn in 0 .. maxTurns-1:
    budgetSpent  = toolCalls.length >= maxToolCalls      // ← guard 1
    forceFinal   = (turn == maxTurns-1) OR budgetSpent    // ← guard 2

    response = model.complete(
      system = forceFinal ? system + synthesisInstruction : system,
      tools  = forceFinal ? NONE : toolSchemas             // ← yank tools
    )
    append response to messages

    toolUses = tool_use blocks in response
    if toolUses is empty:                                  // model is done
      finalText = response text
      break

    for each toolUse:                                      // ACTION
      result = tools.callTool(name, args)   // (or capture the error)
      record it; emit trace events
    append tool results to messages as the next user turn  // OBSERVATION
```

**Name each part by what breaks without it:**

- **The message accumulator (`messages`).** Drop it and every turn starts blind —
  the model never sees the tool results it just asked for. This is the
  Observation half of ReAct.
- **The turn budget (`maxTurns`).** Drop it and a model that keeps emitting tool
  calls loops forever. This is the hard ceiling.
- **The tool-call budget (`maxToolCalls`).** Drop it and a single turn can fan
  out 20 tool calls; the budget caps *total* spend across turns, independent of
  turn count.
- **The forced synthesis turn (`forceFinal`).** This is the part people forget,
  and it's the most load-bearing. On the last turn, the code sets `tools =
  undefined` and appends a synthesis instruction ("you have NO more tool calls
  available; output your final answer"). Without it, a model that hits the turn
  ceiling mid-investigation just emits *another* tool call you have no budget to
  run — and you get back a tool request instead of an answer. The fence forces a
  conclusion.

**Skeleton vs. hardening.** The four parts above are the skeleton. Layered on
top as hardening: trace emission (every step, tool call, and token count
becomes a `CapabilityEvent`), tool-result truncation (a 16k-char cap so one
giant result can't blow the context), and the recovery turn below.

### Move 2.5 — the fallback recovery turn

After the loop, if the agent needs structured output, it parses `finalText`. If
that parse returns `null` *and* a `recoveryPrompt` is supplied, the loop fires
**one more** model call — a clean-slate turn with a strict system prompt
("output ONLY the structured answer; never ask for more data") and the
completed tool results stuffed into the prompt as evidence.

```
  Recovery: when the final answer won't parse

  loop ends ──► parseResult(finalText)
                     │
                ┌────┴────┐
                │ null?   │ no ──► return parsed
                ▼ yes
          recoveryPrompt(toolCalls)   ← repackage evidence
                     │
                     ▼
          one more model.complete()   ← tools OFF, strict system
                     │
                     ▼
          parseResult(recoveryText)   ← last chance, else null
```

This is the difference between "the agent failed" and "the agent produced messy
prose on its last turn but we salvaged the answer." Cheap insurance: one extra
call, only on parse failure.

### Move 3 — the principle

An agent is a loop the *model* drives inside a fence the *code* controls. The
freedom (which tool, how many, in what order) belongs to the model; the bounds
(how long, how much, and the compelled final answer) belong to you. A loop with
no fence isn't an agent — it's an unbounded liability.

## Primary diagram

The full loop, every box and budget labelled.

```
  runAgentLoop — full picture

  RunAgentLoopOptions { system, userPrompt, toolSchemas,
                        maxTurns=8, maxToolCalls?, synthesisInstruction,
                        parseResult?, recoveryPrompt? }
        │
        ▼
  messages = [{ role: user, content: userPrompt }]
        │
        ▼
  ┌──────────────────────── for turn in 0..maxTurns-1 ───────────────────────┐
  │  budgetSpent = toolCalls >= maxToolCalls                                  │
  │  forceFinal  = last turn OR budgetSpent                                   │
  │       │                                                                   │
  │       ▼                                                                   │
  │  model.complete({ system(+synthesis if forceFinal),                       │
  │                   tools: forceFinal ? none : toolSchemas })               │
  │       │                                                                   │
  │       ├─► emit model_usage trace (tokens)                                 │
  │       ▼                                                                   │
  │  toolUses empty? ──yes──► finalText = text; BREAK                         │
  │       │ no                                                                │
  │       ▼                                                                   │
  │  run each tool (truncate result to 16k), emit tool_call_* trace,          │
  │  append results as next user message ──► loop                            │
  └───────────────────────────────────────────────────────────────────────────┘
        │
        ▼
  parseResult(finalText) → null? → recoveryPrompt → one strict call → parse
        │
        ▼
  return { finalText, toolCalls, parsed }
```

## Implementation in codebase

**Use cases.** Every agent calls this. `RecommendationAgent.propose()` runs it
with `maxTurns: 6, maxToolCalls: 4` to turn a diagnosis into ≤3 grounded
recommendations
(`packages/agents/recommendation/src/recommendation-agent.ts:77-93`). The query
agent runs it with `maxTurns: 8, maxToolCalls: 6` to answer NL questions over
~49 read-only tools (`packages/agents/query/src/query-agent.ts:85-99`). The
anomaly monitor runs it to scan 10 ecommerce categories
(`packages/agents/anomaly-monitoring/src/monitoring-agent.ts:66-83`).

**The loop core**, `packages/runtime/src/run-agent-loop.ts:98-190`:

```
  packages/runtime/src/run-agent-loop.ts  (lines 98-109)

  for (let turn = 0; turn < maxTurns; turn += 1) {     ← the turn ceiling
    signal?.throwIfAborted();                           ← cancellation seam
    const budgetSpent =
      maxToolCalls !== undefined && toolCalls.length >= maxToolCalls;
    const forceFinal = turn === maxTurns - 1 || budgetSpent;  ← THE flip
    const response = await model.complete({
      system: forceFinal && synthesisInstruction
        ? `${system}\n\n${synthesisInstruction}`        ← append the nudge
        : system,
      messages,
      tools: forceFinal ? undefined : toolSchemas,      ← yank the tools
      maxTokens,
      signal,
    });
       │
       └─ `forceFinal` is the load-bearing line. When true, the model gets
          NO tools and a "you have no more calls" instruction, so it must
          answer. Without it, the last turn could emit another unrunnable
          tool call and you'd return a request instead of an answer.
```

```
  packages/runtime/src/run-agent-loop.ts  (lines 131-135)

  const toolUses = toolUsesFromContent(response.content);
  if (toolUses.length === 0) {     ← model emitted no tool call…
    finalText = text;              ← …so it's done. Capture and break.
    break;
  }
       │
       └─ The natural exit. The budget is the *unnatural* exit (forced).
          Most turns end here; the fence only fires when the model would
          otherwise keep going.
```

The tool execution + error capture is at `:139-189`: each tool runs inside a
`try/catch`, errors become a `{ error: message }` result fed back to the model
as an observation (so the model can recover by trying a different tool), and
results are truncated to `MAX_TOOL_RESULT_CHARS = 16_000` (`:52-57`).

**The forced-synthesis helper**, `packages/runtime/src/run-agent-loop.ts:72-74`:

```
  export function buildSynthesisInstruction(middle: string): string {
    return `You have NO more tool calls available. ${middle}`
         + ` Do not say you need more queries.`;
  }
```

Each agent passes its own `middle` — e.g. recommendation says "Respond with ONLY
a JSON array of at most 3 recommendation objects…"
(`packages/agents/recommendation/src/recommendation-agent.ts:88-90`).

**The recovery turn**, `packages/runtime/src/run-agent-loop.ts:192-228`: runs
`parseResult`, and on `null` fires `runRecoveryTurn` with a hardcoded strict
system prompt ("You are concluding a completed investigation. Output ONLY the
structured answer… Never ask for more data.") at `:211-213`.

## Elaborate

ReAct (Yao et al., 2022) named the Thought/Action/Observation interleaving that
makes tool-using models debuggable — the model externalizes its reasoning
between actions, so a bad trace is readable. AptKit's contribution on top is
purely operational: the budgets and the forced-synthesis turn are the scar
tissue of running these loops against real providers, where "the model decides
when to stop" is not a guarantee you can ship on.

The forced-synthesis turn connects directly to the eval layer: because the loop
*always* produces a `finalText` (never an open-ended tool request), the parse +
validate step downstream (`05-evals-and-observability/`) always has something
concrete to check. The fence and the eval are designed together.

Adjacent concepts: tool calling (`02-tool-calling.md`), error recovery
(`06-error-recovery.md`), structured outputs (`01-llm-foundations/04-structured-outputs.md`).
The multi-agent *orchestration* on top of this loop (monitor → diagnose →
recommend) is agent-architecture territory — see `.aipe/study-agent-architecture/`.

## Project exercises

*Provenance: Phase 4 — Agents and tool use (C4.x). No `aieng-curriculum.md`
present; IDs are by-phase convention. Case A — the loop is implemented; these
harden it.*

### Exercise — loop-detection guard

- **Exercise ID:** `[B4.x]` Phase 4, error-recovery concept
- **What to build:** Add detection of repeated identical tool calls inside
  `runAgentLoop` — track `(toolName, JSON.stringify(args))` per turn; if the
  same pair fires N times, inject a "you already ran that; try a different
  approach" observation instead of re-running it.
- **Why it earns its place:** The spec's error-recovery table lists "LLM loops
  on same tool repeatedly" as a named failure mode AptKit doesn't yet handle.
  Naming and fixing it is a strong interview signal.
- **Files to touch:** `packages/runtime/src/run-agent-loop.ts`,
  `packages/runtime/test/run-agent-loop.test.ts`.
- **Done when:** A fixture that returns the same tool call 3× triggers the
  injected message and the loop terminates within budget; a unit test proves it.
- **Estimated effort:** `1–4hr`

### Exercise — surface budget exhaustion in the trace

- **Exercise ID:** `[B4.x]` Phase 4, observability of agents
- **What to build:** Emit a distinct `warning` `CapabilityEvent` when
  `forceFinal` fires because of `budgetSpent` (vs. natural last turn), so Studio
  can show "this run hit its tool-call ceiling."
- **Why it earns its place:** Distinguishing "finished naturally" from "ran out
  of budget" is the difference between a healthy run and a near-miss — exactly
  the kind of operational visibility interviewers probe for.
- **Files to touch:** `packages/runtime/src/run-agent-loop.ts`,
  `packages/runtime/src/events.ts` (no shape change needed — reuse `warning`),
  `apps/studio` trace rendering.
- **Done when:** A budget-exhausted replay artifact contains the warning event
  and Studio renders it.
- **Estimated effort:** `1–4hr`

## Interview defense

**Q: Walk me through your agent loop. What stops it running forever?**
Three things, and I'd sketch the fence:

```
  budget        forced synthesis      natural exit
  maxTurns ───►  last turn:       ──►  model emits no
  maxToolCalls   tools OFF + nudge      tool_use → break
```

"`maxTurns` is the hard ceiling. `maxToolCalls` caps total spend independent of
turn count. And the part people miss — on the last turn I strip the tools and
append a synthesis instruction, so the model is *forced* to answer instead of
emitting one more tool call I can't run. That's `forceFinal` in
`run-agent-loop.ts:102`."
*Anchor: the flip from LLM-decides to code-decides happens on one boolean.*

**Q: The model's final answer comes back as prose, not the JSON you need. Then
what?**
"One recovery turn. I re-call the model with the tools off, a strict
'output only the structured answer' system prompt, and the tool results I
already gathered repackaged as evidence — `runRecoveryTurn`,
`run-agent-loop.ts:204`. If *that* doesn't parse, I return null and the caller
handles the empty case. One extra call, only on failure."
*Anchor: parse failure is a recoverable state, not a dead end.*

## Validate

- **Reconstruct:** From memory, write the loop kernel — the four skeleton parts.
  Check against `packages/runtime/src/run-agent-loop.ts:98-190`.
- **Explain:** Why does `forceFinal` set `tools: undefined` rather than just
  appending the instruction? (Because a model with tools available will use them
  even when told not to; removing the tools makes it structurally impossible.)
  See `:108`.
- **Apply:** The recommendation agent sets `maxToolCalls: 4`. A diagnosis needs
  5 lookups to ground fully. What happens? (On the 4th tool call,
  `budgetSpent` becomes true; the next turn is forced-final with the evidence so
  far.) Trace it through `recommendation-agent.ts:86-92`.
- **Defend:** Why truncate tool results to 16k chars
  (`run-agent-loop.ts:52`) rather than let them flow? (A single large tool
  result can crowd out the rest of the context window and spike cost; truncation
  bounds per-observation context growth.)

## See also

- [02-tool-calling.md](02-tool-calling.md) — what a tool call is, the brain/hands split
- [06-error-recovery.md](06-error-recovery.md) — the full failure-mode table
- [01-agents-vs-chains.md](01-agents-vs-chains.md) — when to reach for a loop at all
- [../01-llm-foundations/04-structured-outputs.md](../01-llm-foundations/04-structured-outputs.md) — what `parseResult` validates
- [../05-evals-and-observability/04-llm-observability.md](../05-evals-and-observability/04-llm-observability.md) — the trace events the loop emits
