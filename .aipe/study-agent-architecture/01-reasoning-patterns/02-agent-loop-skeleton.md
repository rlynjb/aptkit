# 02 — The Agent Loop Skeleton

*Agent loop / agent runtime / "the harness" — Language-agnostic (the four-part
skeleton — state, step, execute, terminate — is the same in every framework;
the names differ).*

## Zoom out, then zoom in

This is the single most important file in the sub-section, so start by seeing
exactly how small the thing is and how much sits on top of it.

```
  How much rides on one 130-line function

  ┌─ Studio (apps/studio) ───────────────────────────────────┐
  │  React panel → POST /api/replay/*                         │
  └───────────────────────┬───────────────────────────────────┘
                          ▼
  ┌─ 5 capabilities (packages/agents/*) ─────────────────────┐
  │  MonitoringAgent · DiagnosticAgent · RecommendationAgent  │
  │  QueryAgent · RubricImprovementAgent                      │
  │  every one of them calls ───────────────┐                 │
  └─────────────────────────────────────────┼─────────────────┘
                                            ▼
  ┌─ THE KERNEL ─────────────────────────────────────────────┐
  │  ★ runAgentLoop()  packages/runtime/run-agent-loop.ts ★   │ ← we are here
  │  state · step · execute · terminate                       │
  └───────────────────────┬───────────────────────────────────┘
                          ▼
  ┌─ ModelProvider + ToolExecutor (interfaces) ──────────────┐
  └──────────────────────────────────────────────────────────┘
```

One function. Five capabilities depend on it. If it has a bug, all five agents
have that bug. So we're going to treat it like a load-bearing wall: name each
part, and for each part state *what breaks if you remove it.* That's the whole
method here. A skeleton is defined by which bones are structural — pull a
structural bone and the body collapses; pull a decorative one and nothing
happens. We find the structural bones by deletion.

The function is `runAgentLoop<T>` at `run-agent-loop.ts:76`. Forget the tracing
and truncation for a moment — those are decorative. Four bones are structural.

## Structure pass

Trace the **state axis** — "where does the conversation live and when does it
die" — through the loop.

```
  The state axis: where the agent's memory lives

  Part          Holds                         Lifetime
  ────────────  ────────────────────────────  ─────────────────────────────
  messages[]    full conversation so far       born line 94, dies on return
  toolCalls[]   audit log of every tool run     same — in-memory only
  ─ ─ ─ ─ ─ ─   ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─   ─ ─ ─ ─ ─ ─ ─ ─ ─ ◄ SEAM
  (nothing)     no DB, no cache, no episodic    GONE when the function returns
```

The seam is the return statement. Above it, the agent has full memory of its
own run. Below it — the instant `runAgentLoop` returns — that memory is garbage
collected. There is no persistence layer. This is exactly `useState` inside a
component: the state lives while the component is mounted and vanishes on
unmount. `messages` is the agent's `useState`, and the function call is the
mount/unmount boundary. That single fact ("no memory survives the return") is
why the six agents here are stateless and why the latent pipeline passes data by
*return value*, not by shared store. (The repo now ships an episodic-memory
*engine* — `@aptkit/memory`, `remember`/`recall` — but no agent in this loop
calls it; that's a deliberate engine-vs-wired-loop split covered in
`../04-agent-infrastructure/02-agent-memory-tiers.md`.) See
`../03-multi-agent-orchestration/03-sequential-pipeline.md`.

## How it works

### Move 1 — the mental model

The skeleton is four bones: **state** (a growing message array), **step** (one
model call), **execute** (run the tools the model asked for), and **terminate**
(two ways out). The loop is just step→execute→step→execute until terminate.

```
  The four-bone skeleton

  ┌──────────────────────────────────────────────────────────────┐
  │  STATE: messages[] (grows every turn)                          │
  │                                                                │
  │   ┌──────────┐   tool_use?   ┌──────────┐   results   ┌──────┐ │
  │   │  STEP    │──── yes ──────▶│ EXECUTE  │────────────▶│ push │ │
  │   │ model.   │                │ tools.   │   appended  │ into │ │
  │   │ complete │◀───────────────│ callTool │   to state  │ msgs │ │
  │   └────┬─────┘    loop again  └──────────┘             └──────┘ │
  │        │ no tool_use  OR  budget spent                          │
  │        ▼                                                        │
  │   TERMINATE ──▶ return { finalText, toolCalls, parsed }         │
  └──────────────────────────────────────────────────────────────┘
   data flows clockwise; state accumulates in messages[] each lap
```

### Move 2 — the bones, one at a time, found by deletion

**Bone 1 — STATE: the messages array**

```
  messages[] grows by 2 entries per tool-using turn

  turn 0: [user prompt]
          └─▶ model says "call get_metric_timeseries"
  turn 0: [user, assistant(tool_use)]
          └─▶ harness runs tool
  turn 0: [user, assistant(tool_use), user(tool_result)]   ← +2
  turn 1: model sees ALL of the above, decides next step
```

Pseudocode: `messages = [userPrompt]; each turn: push assistant reply, push tool
results.` **Remove it and:** the model has amnesia every turn — it re-asks the
same query forever because it can't see what it already learned. State is what
makes the loop *accumulate* instead of *spin.* It's `useState` you append to.

**Bone 2 — STEP: one model.complete call**

```
  one step = one model call, given all state so far

  model.complete({ system, messages, tools: toolSchemas, maxTokens })
        │
        ▼
  response.content = [ text blocks?, tool_use blocks? ]
```

Pseudocode: `response = await model.complete({ system, messages, tools })`. The
model reads the whole conversation and emits either text (it's done) or
`tool_use` blocks (it wants data). **Remove it and:** there's no agent — the
loop has nothing to advance it. This is the one I/O-bound `await` per turn, the
`fetch` of the loop. Everything else is bookkeeping around this call.

**Bone 3 — EXECUTE: tools.callTool — the intent/execution seam**

```
  the model declares intent; the HARNESS runs it

  model: "I want get_segments({metric:'revenue'})"   ← intent only
                          │
                          ▼  harness, NOT the model, does this:
  tools.callTool('get_segments', {metric:'revenue'})  ← run-agent-loop.ts:159
                          │
                          ▼
  result fed back into messages as a tool_result
```

Pseudocode: `for each tool_use: result = await tools.callTool(name, args); push
tool_result`. This is the most important conceptual seam in any agent: **the
model never runs anything.** It emits a structured request — a name and args —
and the harness, code you control, executes it through the `ToolExecutor`
interface (`run-agent-loop.ts:21`). Think of the model as a component
*dispatching an action* and the harness as the *reducer* that actually performs
the side effect. **Remove it and:** the model can ask for data but never
receives any — it hallucinates instead of querying. This seam is also where the
tool policy and safety live (see `../04-agent-infrastructure/`): because *you*
run the tool, *you* decide which tools exist.

**Bone 4 — TERMINATE: two exits, success and budget**

```
  two independent ways the loop ends — both required

  EXIT A (success):  model emits NO tool_use  ──▶ finalText = text; break
                     run-agent-loop.ts:132-135

  EXIT B (budget):   turn == maxTurns-1  OR  toolCalls >= maxToolCalls
                     run-agent-loop.ts:101-102  ──▶ forceFinal = true
```

Pseudocode: `if no tool_use: break` (A); `forceFinal = turn==max-1 || budgetSpent`
(B). **Remove EXIT A and:** the loop wastes turns even after the model is done.
**Remove EXIT B and:** a model that keeps asking for "one more query" runs
forever and burns your token budget — the classic runaway-agent failure. You
need *both*, because the two exits guard different failures: A handles a
cooperative model, B handles a stuck one.

**The surprising bone — the FORCED SYNTHESIS turn**

Most people stop at "two exits" and miss the load-bearing trick. When EXIT B
fires, the loop does *not* just stop and return whatever's there. It runs **one
more model call with the tools removed and a synthesis instruction appended to
the system prompt** (`run-agent-loop.ts:103-109`):

```
  budget hit → DON'T stop → run one final tool-LESS turn

  forceFinal = true
       │
       ▼
  model.complete({
    system: system + synthesisInstruction,   ← "you have NO more tool calls"
    tools: undefined,                         ← ★ tools REMOVED ★
    messages,                                 ← all evidence gathered so far
  })
       │
       ▼
  model is FORCED to answer from what it has — it cannot ask for more
```

`buildSynthesisInstruction` (`run-agent-loop.ts:72`) returns: *"You have NO more
tool calls available. {middle} Do not say you need more queries."* By passing
`tools: undefined`, the harness makes tool-calling structurally impossible — the
model *can't* ask for more even if it wants to. **Remove it and:** the agent
hits its budget and returns "I need more data to answer" — useless. The forced
synthesis turn is what converts a budget *cutoff* into a budget *deadline*: the
model must produce its best answer from the evidence it has. This is the single
most surprising mechanic in the kernel, and it's why AptKit agents return a real
answer instead of giving up at the budget. (The exact synthesis *wording* lives
in `.aipe/study-prompt-engineering/`; here you only need the *mechanism*: drop
the tools, demand the answer.)

### Move 3 — the principle

An agent loop is four bones — state, step, execute, terminate — and the
hard-won wisdom is all in *terminate*: never let the model decide when to stop
unilaterally. Give it two exits and a forced last word.

## Primary diagram

The full kernel, all four bones plus the forced synthesis turn and the
post-loop parse/recovery tail.

```
  runAgentLoop — the complete skeleton (run-agent-loop.ts:76-202)

  messages = [userPrompt]                            ← STATE  (line 94)
  ┌──────────────────────────────────────────────────────────────────┐
  │ for turn in 0..maxTurns:                          (line 98)        │
  │   budgetSpent = toolCalls >= maxToolCalls         (line 101)       │
  │   forceFinal  = turn==max-1 OR budgetSpent         (line 102) EXIT B│
  │                                                                    │
  │   response = model.complete({                      (line 103) STEP │
  │     system: forceFinal ? system+synthesis : system,                │
  │     tools:  forceFinal ? undefined : toolSchemas,  ← FORCED SYNTH  │
  │     messages })                                                    │
  │                                                                    │
  │   push assistant(response) into messages           (line 124)      │
  │                                                                    │
  │   if no tool_use:  finalText = text; BREAK         (line 132) EXIT A│
  │                                                                    │
  │   for each tool_use:                               (line 139)EXECUTE│
  │     result = tools.callTool(name, args)            (line 159)      │
  │     push tool_result into messages                 (line 189)      │
  └──────────────────────────────────────────────────────────────────┘
  parsed = parseResult(finalText)                     (line 194)       │
  if parsed==null and recoveryPrompt: runRecoveryTurn (line 196)       │
  return { finalText, toolCalls, parsed }             (line 201) ◄ state dies here
```

Read it top to bottom once; the only non-obvious arrows are the two `forceFinal`
ternaries on lines 104 and 106 — that's the forced synthesis turn.

## Implementation in codebase

**Use case: every capability is this kernel + a thin wrapper.** A wrapper's job
is to (1) render a system prompt, (2) filter tools to a policy, (3) set the two
budgets, (4) supply a parser. The kernel does the rest.

The kernel, with the four bones marked — `run-agent-loop.ts`:

```ts
// STATE (line 94): the agent's only memory, dies on return
const messages: ModelMessage[] = [{ role: 'user', content: userPrompt }];
const toolCalls: ToolCallRecord[] = [];

for (let turn = 0; turn < maxTurns; turn += 1) {              // line 98
  // EXIT B precondition (line 101-102): both budgets feed one boolean
  const budgetSpent = maxToolCalls !== undefined && toolCalls.length >= maxToolCalls;
  const forceFinal = turn === maxTurns - 1 || budgetSpent;
  // STEP + FORCED SYNTHESIS (line 103-109): tools dropped when forceFinal
  const response = await model.complete({
    system: forceFinal && synthesisInstruction ? `${system}\n\n${synthesisInstruction}` : system,
    messages,
    tools: forceFinal ? undefined : toolSchemas,   // ← tools removed = can't ask for more
    maxTokens, signal,
  });
  messages.push({ role: 'assistant', content: response.content });   // grow STATE (line 124)
  const toolUses = toolUsesFromContent(response.content);
  if (toolUses.length === 0) { finalText = text; break; }            // EXIT A (line 132-135)
  // EXECUTE (line 139-189): harness runs each tool the model asked for
  for (const toolUse of toolUses) {
    const { result } = await tools.callTool(toolUse.name, toolUse.input, { signal }); // line 159
    // ...push tool_result into messages (line 189)
  }
}
```

`buildSynthesisInstruction` — `run-agent-loop.ts:72`:

```ts
// line 72: the forced-synthesis wording the wrappers fill in the middle of
export function buildSynthesisInstruction(middle: string): string {
  return `You have NO more tool calls available. ${middle} Do not say you need more queries.`;
}
```

The post-loop tail — parse, then one-shot recovery — `run-agent-loop.ts:192-199`:

```ts
let parsed: T | null = null;
if (options.parseResult) {
  parsed = options.parseResult(finalText);                 // line 194
  if (parsed === null && options.recoveryPrompt) {         // parse failed
    const recoveryText = await runRecoveryTurn(options, options.recoveryPrompt(toolCalls)); // line 196
    parsed = recoveryText === null ? null : options.parseResult(recoveryText);
  }
}
```

`runRecoveryTurn` (`run-agent-loop.ts:204`) is a *fresh-message* one-shot: a new
conversation containing only the evidence and a "output ONLY the structured
shape, never ask for more data" system prompt (line 211-216). It's a second
forced-synthesis attempt for the case where the first answer parsed to garbage.

**The wrappers** all look the same — here's where the budgets get set:

- `monitoring-agent.ts:76-77` — `maxTurns: 8, maxToolCalls: 6`
- `diagnostic-agent.ts:73-74` — `maxTurns: 8, maxToolCalls: 6`
- `recommendation-agent.ts:86-87` — `maxTurns: 6, maxToolCalls: 4`
- `query-agent.ts:94-95` — `maxTurns: 8, maxToolCalls: 6`
- `rubric-improvement-agent.ts:75-77` — `maxTurns: 6, maxToolCalls: 3, maxTokens: 2400`

Defaults if a wrapper omits them: `maxTurns: 8`, `maxTokens: 4096`,
`maxToolCalls` optional (`run-agent-loop.ts:87-89`).

## Elaborate

**Origin.** This skeleton is the operational core of the ReAct paper (Yao et
al., 2022) once you strip the prompting and keep only the control flow. The
modern "agent harness" — a host loop that owns state and tool execution while
the model only emits intents — is the dominant production shape (Anthropic's
tool-use loop, the OpenAI assistants loop, every framework's `AgentExecutor`).
AptKit's version is deliberately small and un-frameworked.

**Adjacent concepts.** The two budgets are *defense in depth*: `maxTurns` bounds
*conversation length*, `maxToolCalls` bounds *external work* — a model can burn
many turns reasoning without calling tools, or many tool calls in one turn, so
you bound both. The `signal` (AbortSignal) threaded through is cancellation —
the same `AbortController` you pass to `fetch`. The truncation
(`MAX_TOOL_RESULT_CHARS`, line 52) is a *decorative* bone: remove it and you
risk overflowing context, but the loop still runs — it's a guard, not structure.

## Interview defense

**Q: "Walk me through your agent loop. What stops it?"**

```
  two exits, and you need both

  cooperative model  ──▶ stops asking ──▶ EXIT A (no tool_use, break)
  stuck model        ──▶ keeps asking ──▶ EXIT B (budget) ──▶ forced synthesis
```

Anchor: "Two exits — success and budget — and the budget exit doesn't just stop,
it strips the tools and forces a final answer from the evidence on hand."

**Q: "Who actually runs the tools — the model?"**

```
  intent vs execution — the seam every agent has

  model: emits {name, args}   ← intent, structured, runs nothing
  harness: tools.callTool()   ← execution, your code, your policy (line 159)
```

Anchor: "The model dispatches an action; my harness is the reducer that
performs it — that seam is where the tool policy and safety live."

**Q: "What happens when the agent hits its budget mid-investigation?"**

```
  budget hit ─▶ forceFinal=true ─▶ tools:undefined + synthesis prompt
            ─▶ model MUST answer from evidence (can't ask for more)
```

Anchor: "It doesn't fail — it runs one tool-less turn that turns the cutoff into
a deadline. That forced synthesis turn is the part people miss." This is the
load-bearing skeleton part: the budget exit is worthless without the forced
synthesis turn behind it.

## Validate

- **Reconstruct:** Redraw the four-bone skeleton from memory and label each bone
  with its line in `run-agent-loop.ts` (state 94, step 103, execute 159,
  terminate 102+132).
- **Explain:** Why does `forceFinal` set `tools: undefined` instead of just
  appending a "stop now" instruction? (`run-agent-loop.ts:106` — making it
  structurally impossible beats asking nicely; the model can't emit a tool_use
  if no tools are offered.)
- **Apply:** A new capability needs at most 2 external queries but lots of
  reasoning. Which budget do you tighten and which do you leave? (tighten
  `maxToolCalls` to 2, leave `maxTurns` generous — see the two-budget rationale;
  `recommendation-agent.ts:86-87` is the precedent at 6/4.)
- **Defend:** A teammate wants to drop the forced synthesis turn "to save a model
  call." What breaks? (the agent returns "I need more queries" at every budget
  hit — `buildSynthesisInstruction`'s whole reason for existing,
  `run-agent-loop.ts:72`.)

## See also

- [01-chains-vs-agents.md](01-chains-vs-agents.md) — why this loop exists at all
- [03-react.md](03-react.md) — the reasoning pattern this kernel implements
- [05-reflexion-self-critique.md](05-reflexion-self-critique.md) — same kernel,
  the model judges instead of produces
- [07-routing.md](07-routing.md) — the one-shot `classifyIntent` call that is
  *not* this loop
- `../03-multi-agent-orchestration/03-sequential-pipeline.md` — why state dying
  on return forces value-passing between agents
- `../04-agent-infrastructure/` — the tool policy that lives at the execute seam
- `.aipe/study-prompt-engineering/` — the synthesis + recovery prompt *wording*
