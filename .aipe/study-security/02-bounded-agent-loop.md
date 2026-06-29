# Bounded agent loop

**Industry name(s):** iteration budget / agent loop guard · bounded ReAct
loop · **Type:** Industry standard (resource-bounding an autonomous loop)

## Zoom out, then zoom in

An agent loop hands control to the model: the model decides whether to call
a tool or stop, and the loop does what it says. That's the point of an
agent — and the danger. A model that's stuck, confused, or adversarial can
keep asking for tool calls forever, burning tokens (real money) and tool
side effects on every turn. The bound is the cap that says *you get N turns,
then I take control back.*

```
  Zoom out — where the loop bound lives

  ┌─ Agent layer ─────────────────────────────────────────────┐
  │  RagQueryAgent / QueryAgent / ... → runAgentLoop(options)  │
  └──────────────────────────┬────────────────────────────────┘
                             │  maxTurns, maxToolCalls, signal
  ┌─ Runtime layer ──────────▼────────────────────────────────┐
  │  ★ runAgentLoop ★  for (turn < maxTurns) { ... }          │ ← we are here
  │     budget check → forceFinal → strip tools on last turn  │
  └──────────────────────────┬────────────────────────────────┘
                             │  model.complete(...)
  ┌─ Provider layer ─────────▼────────────────────────────────┐
  │  Gemma (local) / Anthropic / OpenAI / fallback chain      │
  └─────────────────────────────────────────────────────────────┘
```

Zoom in: this is the **iteration budget** (`maxTurns` / `maxToolCalls`) —
the hard ceiling on how long the model stays in control. The question it
answers: *what stops a runaway model?* Not a timeout you hope fires — a
counter the loop checks every turn.

## Structure pass

**Layers:** the agent sets the *budget* (config), the loop *spends* it
(control flow), the provider is *called* under it.

**Axis — control:** trace "who decides whether the loop continues?" down
the layers.

```
  The control axis flips at the budget check

  ┌─ normal turn ──┐   seam: budget    ┌─ final turn ──────┐
  │ MODEL decides  │ ═══════╪════════►  │ LOOP decides:     │
  │ (call or stop) │  (it flips)        │ no more tools,    │
  │                │                    │ synthesize NOW    │
  └────────────────┘                    └───────────────────┘
         ▲                                      ▲
         └──── "who decides continue?" ─────────┘
               normal: the model · at the budget: the loop
```

For most turns the model is in control — it chooses to call a tool or emit
a final answer. The moment the budget is spent, control flips to the loop:
it strips the tools and forces synthesis. That flip is the whole safety
property.

**Seam:** the `budgetSpent` / `forceFinal` computation at the top of each
iteration (`run-agent-loop.ts:101-102`). One spot decides whether this turn
is normal or terminal.

## How it works

#### Move 1 — the mental model

Think of a `for` loop with a `break` the model can trigger early — but a
hard `maxTurns` it can never exceed. You already write this shape: a retry
loop with a max-attempts cap, where the body can `return` on success but the
counter guarantees termination. The agent loop is that, where the "body" is
a model call and the early exit is "the model stopped asking for tools."

```
  The bounded loop kernel

  turn = 0
  ┌───────────────────────────────────────────────┐
  │ while turn < maxTurns:                          │
  │   budgetSpent = toolCalls >= maxToolCalls       │
  │   forceFinal  = (turn == last) OR budgetSpent   │
  │   resp = model.complete(tools = forceFinal? none│ ← tools removed
  │                                  : toolSchemas) │   when forced
  │   if resp has no tool calls: return resp.text   │ ← model's early exit
  │   run the tools; append results; turn += 1      │
  └───────────────────────────────────────────────┘
  (loop ALWAYS terminates: turn strictly increases)
```

#### Move 2 — the step-by-step walkthrough

**The budget is set by the agent, with a safe default.** `runAgentLoop`
destructures `maxTurns = 8` as a default and accepts an optional
`maxToolCalls` budget. An agent that forgets to set a bound still gets 8 —
the loop never runs unbounded by accident.

```typescript
// packages/runtime/src/run-agent-loop.ts:87-92
maxTurns = 8,        // hard ceiling on iterations; default 8
maxTokens = 4096,
maxToolCalls,        // optional cumulative tool-call budget
synthesisInstruction,
signal,              // operator abort handle
```

The recommendation agent sets `maxTurns: 6`, the query agent `6` — each
capability tunes its own ceiling. The default is the floor of safety.

**Every turn re-checks the budget before calling the model.** At the top of
each iteration the loop computes two booleans: is the tool-call budget
spent, and is this the last turn? Either makes this turn *terminal*.

```typescript
// packages/runtime/src/run-agent-loop.ts:98-102
for (let turn = 0; turn < maxTurns; turn += 1) {
  signal?.throwIfAborted();                                    // kill switch
  const budgetSpent = maxToolCalls !== undefined && toolCalls.length >= maxToolCalls;
  const forceFinal = turn === maxTurns - 1 || budgetSpent;     // terminal turn?
```

`turn < maxTurns` in the loop header is the *unconditional* guarantee — the
counter strictly increases, so the loop terminates no matter what the model
does. `budgetSpent` is the *early* terminal trigger when tool calls run out
before turns do.

**On the terminal turn, the loop removes the tools.** This is the move
that's easy to miss. It's not enough to stop looping — on the last turn the
loop hands the model *no tools at all*, so the only thing it can do is
produce a final answer. Optionally it appends a `synthesisInstruction` to
push the model to answer from what it already has.

```typescript
// packages/runtime/src/run-agent-loop.ts:103-109
const response = await model.complete({
  system: forceFinal && synthesisInstruction
    ? `${system}\n\n${synthesisInstruction}` : system,
  messages,
  tools: forceFinal ? undefined : toolSchemas,   // ← no tools on terminal turn
  maxTokens,
  signal,
});
```

**The model's own early exit.** When a response carries no tool calls, the
loop takes that as the final answer and breaks
(`run-agent-loop.ts:131-135`). So the loop ends one of three ways: the model
stops (early exit), the turn counter hits `maxTurns` (hard ceiling), or the
tool budget is spent (`budgetSpent` forces synthesis). All three terminate.

**The abort signal is the human override.** `signal?.throwIfAborted()` at
the top of each turn (`:99`) lets the operator — or buffr's session
runtime — cancel a run mid-flight. The cap defends against the model; the
signal defends against everything else.

#### Move 2 variant — the load-bearing skeleton

The kernel is **counter + per-turn budget check + tool-strip on the
terminal turn + termination**:

- **The strictly-increasing counter (`turn += 1`, `turn < maxTurns`)** —
  *drop it and a model that always asks for one more tool never stops.* This
  is the unconditional termination guarantee. The single most important
  part, and the one a naive "loop until the model says it's done"
  implementation omits.
- **The per-turn budget check** — *drop it and `maxToolCalls` is ignored;*
  the loop runs the full `maxTurns` even when the tool budget should have
  ended it sooner, wasting calls.
- **The terminal-turn tool strip (`forceFinal ? undefined : toolSchemas`)**
  — *drop it and the last allowed turn can still request a tool call that
  never gets serviced,* leaving the run with no final answer. This converts
  "out of budget" into "produce the answer now."
- **Hardening, not kernel:** `maxTokens`, the `synthesisInstruction`, the
  abort `signal`. Useful, but the loop is still bounded without them.

The interview tell: naming the **hard iteration ceiling** (the part people
forget — they describe "the model decides when to stop" and miss that
*something* must guarantee it stops even when the model won't).

#### Move 3 — the principle

Any loop that yields control to an untrusted decider needs a bound the
decider can't move. The model can end the loop early but can never extend
it past `maxTurns`. That asymmetry — cooperative exit, mandatory cap — is
the whole pattern, and it's the same shape as a retry-with-max-attempts or
a request timeout: trust the happy path, but own the ceiling.

## Primary diagram

```
  Bounded agent loop — the full picture

  ┌─ runAgentLoop (packages/runtime/src/run-agent-loop.ts) ────┐
  │                                                             │
  │  turn 0 ─► budget check ─► model.complete(tools=schemas)    │
  │              │                     │                        │
  │              │            no tool calls? ──► RETURN (early)  │
  │              │                     │ yes                    │
  │              ▼                     ▼                        │
  │      budgetSpent / last?    run tools, append results       │
  │              │ no                  │                        │
  │              └──────── turn += 1 ◄─┘                        │
  │              │ yes (forceFinal)                             │
  │              ▼                                              │
  │      model.complete(tools = NONE) ─► RETURN (synthesize)    │
  │                                                             │
  │  signal.throwIfAborted() checked every turn (kill switch)   │
  └─────────────────────────────────────────────────────────────┘
```

## Elaborate

This is the resource-bound on a ReAct-style loop (reason → act → observe,
repeated). The classic failure it prevents is the "infinite tool-call
spiral" — a model that keeps deciding it needs one more search, especially a
weaker local model like Gemma that's emulating tool-calling and can loop on
ambiguous output. The bound caps the *cost* axis (tokens, latency, side
effects) the way the allowlist (`01`) caps the *reach* axis. Together they
define the agent's sandbox: limited tools, limited turns.

## Interview defense

**Q: What stops an agent loop from running forever?**

A strictly-increasing turn counter with a hard ceiling the model can't move
— `maxTurns`, default 8. The model can exit early by not requesting a tool,
but it can never push past the ceiling, because `turn < maxTurns` is checked
unconditionally each iteration. There's also an optional `maxToolCalls`
budget for finer control, and on the terminal turn the loop strips the tools
so the model is forced to synthesize an answer rather than keep calling.

```
  model can: end early (no tool call)
  model cannot: exceed maxTurns (counter is unconditional)
  → cooperative exit, mandatory cap
```

*Anchor: the hard iteration ceiling is the part people forget — "the model
decides when to stop" needs a backstop that guarantees it stops.*

**Q: Budget's spent but the model still wants a tool — what happens?**

The loop sets `forceFinal` and calls the model with `tools: undefined`, so
there's no tool to request — the only valid output is a final answer,
optionally nudged by a `synthesisInstruction`. That converts "out of
budget" into "answer now" instead of leaving the run hung with no result.

*Anchor: terminal turn strips the tools — out-of-budget becomes
synthesize-now.*

## See also

- `01-least-privilege-tool-policy.md` — limits *what* the loop can reach
- `03-hallucination-tolerant-retrieval.md` — the tool the loop calls
- `audit.md` lens 7 — the loop as a model-as-attacker control
- `study-agent-architecture` — the loop as architecture (pipeline vs loop)
