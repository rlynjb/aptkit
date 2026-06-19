# Agents vs chains (who decides the steps?)

**Industry names:** chain / pipeline / DAG vs agent / agentic loop · *Industry standard*

## Zoom out, then zoom in

The whole pipeline in AptKit — monitor for anomalies, diagnose the worst one,
recommend actions — looks like a chain from the outside: three boxes, output of
one feeds the next, fixed order. But zoom into any one box and it is *not* a
chain. It is an agent loop. The distinction lives at two altitudes, and you have
to see both.

```
  Zoom out — chains across, agents inside

  ┌─ Orchestration layer (fixed pipeline — a CHAIN) ──────────────┐
  │  monitor ──► diagnose ──► recommend   (you wrote this order)   │
  └──────┬───────────┬───────────┬────────────────────────────────┘
         │           │           │   each box is…
  ┌─ Agent layer ────▼───────────▼────────────────────────────────┐
  │  ★ runAgentLoop ★  — inside each box, the MODEL picks steps    │ ← we are here
  └──────┬─────────────────────────────────────────────────────────┘
         │  ModelProvider.complete()
  ┌─ Provider layer ─▼─────────────────────────────────────────────┐
  │  anthropic / openai / fixture                                  │
  └────────────────────────────────────────────────────────────────┘
```

Zoom in: a **chain** is steps *you* hard-code — call A, then B, then C, every
time, no matter what. An **agent** is a loop where the *model* decides which step
comes next and how many steps there are. The question this file answers is the
one you ask before building anything: *do I know the steps in advance, or does
the model?* If you know them, write a chain — it's cheaper, deterministic, and
debuggable. If you don't, you need an agent.

## Structure pass

**Layers.** Two, and they're easy to confuse. The *outer* orchestration layer
(the monitor→diagnose→recommend pipeline) and the *inner* agent layer (each
single-purpose loop).

**Axis — who decides control flow?** Trace that one question down the stack and
watch the answer flip. Outer pipeline: *code* decides (the order is written in
TypeScript). Inner loop: *the model* decides (it picks which tool, how many
times, in what order). One tool call deep: nobody decides — the *tool* just runs.

```
  One question down the layers — "who picks the next step?"

  ┌──────────────────────────────────┐
  │ outer: monitor→diagnose→recommend │  → CODE decides (chain)
  └──────────────────────────────────┘
      ┌──────────────────────────────┐
      │ inner: runAgentLoop per box   │  → MODEL decides (agent)
      └──────────────────────────────┘
          ┌──────────────────────────┐
          │ innermost: one tool call  │  → TOOL just runs
          └──────────────────────────┘
```

**Seams.** The load-bearing seam is the boundary between the pipeline and the
loop — it's where control flips from "code decides the sequence" to "model
decides the sequence." That flip is the entire definition of an agent. If
nothing flips at a boundary, you don't have an agent there, you have another
chain step.

## How it works

You already know a chain: it's a `.then().then().then()` or a function that
calls three other functions in order. The control flow is in *your* source.
An agent is the opposite — the control flow lives in the model's head, and your
code is a loop that keeps asking "what next?" until the model says "done."

### Move 1 — the mental model

```
  Chain vs agent — same goal, opposite control

  CHAIN (you wrote the arrows)
  step A ──► step B ──► step C ──► done
  control: in your code. count: fixed. order: fixed.

  AGENT (the model draws the arrows at runtime)
        ┌─────────────────────────────┐
        ▼                             │
  ask model "what next?" ──► tool? ──┘ (yes: run it, loop)
        │                       │
        │                       └─ no: done
  control: in the model. count: variable. order: variable.
```

A chain is a recipe; an agent is a cook. The recipe lists steps in order and you
follow them. The cook tastes, decides, and acts — you only set the kitchen rules
(budget, allowed ingredients) and wait for the dish.

### Move 2 — the trade you're actually making

**The chain's promise: determinism.** Bridge from a unit test — a chain is
testable the way a pure function is, because the same input runs the same steps
every time. You get predictable cost (you know it's exactly 3 model calls),
predictable latency, and a stack trace you can read. The boundary where it breaks:
the moment a step's *next* step depends on what the previous step *found*. A
chain can't branch on content it hasn't seen at author-time without you encoding
every branch by hand — and that's a combinatorial explosion.

```
  When a chain stops being enough

  fixed:   "fetch metric → format → return"        ✓ chain
  dynamic: "investigate WHY revenue dropped"        ✗ chain
           (the 2nd query depends on the 1st result —
            you can't author the branch in advance)
```

**The agent's promise: adaptivity.** The model reads each tool result and picks
the next move based on what it found — exactly the branch a chain can't author.
The boundary where *this* breaks: the model can loop forever, fan out 20 tool
calls, or never produce a parseable answer. Freedom without a fence is a liability.
That's why every AptKit agent is the *bounded* loop from `03-react-pattern.md`:
the model gets the freedom, your code keeps the budget.

```
  Agent = model's freedom INSIDE code's fence

  ┌─ code owns the fence ───────────────────────────┐
  │   maxTurns · maxToolCalls · forced synthesis     │
  │   ┌─ model owns the moves ──────────────────┐    │
  │   │  which tool, how many, in what order     │    │
  │   └──────────────────────────────────────────┘    │
  └──────────────────────────────────────────────────┘
```

### Move 3 — the principle

Reach for a chain when you know the steps; reach for an agent when only the model
can know them at runtime. The cost of an agent is determinism — you trade a
predictable 3-call pipeline for a variable loop you must fence. So the senior
move is *single-purpose agents inside a fixed chain*: the orchestration is a
chain you can reason about, and the loop only appears where genuine runtime
investigation is required. AptKit is the agent shape, not chains — but each agent
is single-purpose, and the pipeline that strings them together is a chain.

## Primary diagram

The full picture: a fixed outer chain, an agent loop inside each box, one engine
shared by all three.

```
  AptKit — chains outside, agents inside, one engine

  ORCHESTRATION (chain — code-ordered)
  ┌──────────┐   ┌───────────┐   ┌──────────────┐
  │ monitor  │──►│ diagnose  │──►│ recommend    │
  └────┬─────┘   └─────┬─────┘   └──────┬───────┘
       │ each box delegates to…         │
       ▼                ▼               ▼
  ┌──────────────── runAgentLoop ───────────────────┐
  │  model.complete → run tool → feed result → loop │
  │  fence: maxTurns / maxToolCalls / forceFinal     │
  │  RecommendationAgent: maxTurns 6, maxToolCalls 4 │
  └──────────────────────┬───────────────────────────┘
                         │ ModelProvider.complete()
  ┌─ Provider ───────────▼───────────────────────────┐
  │  anthropic / openai / fixture                    │
  └───────────────────────────────────────────────────┘
```

## Implementation in codebase

**Use cases.** Three single-purpose agents, each a loop, each wrapped by a
single-job class. The recommendation agent turns one diagnosis into ≤3 grounded
actions. The query agent answers a free-form NL question. The anomaly monitor
scans ecommerce categories for what changed. None of them hard-codes a sequence
of tool calls — each hands the model an allowlist and a budget and lets it
investigate.

The single clearest proof that each box is an *agent* (not a chain) is that the
step count is a *budget*, not a constant:

```
  packages/agents/recommendation/src/recommendation-agent.ts  (lines 86-90)

  maxTurns: 6,                     ← UP TO 6 model round-trips, not exactly 6
  maxToolCalls: 4,                 ← UP TO 4 tool calls total — the model
                                      decides whether it needs 0, 1, or 4
  synthesisInstruction: buildSynthesisInstruction(
    'Stop querying now and output your final answer. …',
  ),
       │
       └─ a chain would say "call get_scenario, then list_segmentations,
          then answer." This says "you may make at most 4 calls — pick
          which ones." That's the model deciding the steps. The number
          is a ceiling the code owns, not a script the code wrote.
```

Contrast the *orchestration* seam — the recommendation agent's input is a
`Diagnosis` produced by a *different* agent upstream
(`recommendation-agent.ts:64`, `propose(anomaly, diagnosis)`). The pipeline that
feeds one agent's output into the next is the chain; the propose() loop inside is
the agent. Same file, two altitudes, two answers to "who decides control flow?"

The shared engine itself — the loop that makes every one of these an agent — is
`runAgentLoop` at `packages/runtime/src/run-agent-loop.ts:76-202`. See
`03-react-pattern.md` for its full anatomy.

## Elaborate

The chain-vs-agent split predates LLMs by decades — it's the difference between a
static DAG (Airflow, a build system, a `Promise` chain) and a planner that emits
actions at runtime (classical AI planning, now ReAct). What LLMs changed is that
the "planner" is now a frozen model you prompt, not a search algorithm you wrote.
The trade is identical to the old one: determinism and debuggability (chain) vs
adaptivity to inputs you couldn't enumerate at author-time (agent).

The practical lesson the industry keeps relearning: **prefer chains; reach for
agents only at the steps that genuinely need runtime decisions.** An agent where
a chain would do is a more expensive, less predictable system with no upside.
AptKit's shape — fixed pipeline, single-purpose agents at the boxes that need
investigation — is the mature version of this.

Adjacent concepts: the loop itself (`03-react-pattern.md`), how the model's
"step" is physically a tool call (`02-tool-calling.md`), and the orchestration
*across* agents, which is its own discipline — see
`.aipe/study-agent-architecture/`.

## Project exercises

*Provenance: Phase 4 — Agents and tool use (C4.x). No `aieng-curriculum.md`
present; IDs are by-phase convention. Case A — the agent shape is implemented;
these sharpen the chain/agent boundary.*

### Exercise — collapse a single-purpose agent into a chain where it's cheaper

- **Exercise ID:** `[A4.1]` Phase 4, agents-vs-chains concept
- **What to build:** Profile the recommendation agent on diagnoses where it makes
  *zero* tool calls (it reasons purely from the diagnosis). For that path, add a
  fast chain: one `generateStructured` call with no loop, no tool schemas. Route
  to it when the diagnosis is self-contained.
- **Why it earns its place:** Recognizing when an agent is overkill — and proving
  it with a cheaper deterministic chain — is the senior judgment this whole file
  teaches. It's a real cost win on the no-tool path.
- **Files to touch:** `packages/agents/recommendation/src/recommendation-agent.ts`,
  `packages/runtime/src/structured-generation.ts`,
  `packages/agents/recommendation/test/recommendation-agent.test.ts`.
- **Done when:** A diagnosis that needs no lookups produces recommendations via
  the single-call chain path; a test asserts zero tool-call records.
- **Estimated effort:** `1–4hr`

### Exercise — make the orchestration chain explicit and traceable

- **Exercise ID:** `[A4.2]` Phase 4, orchestration as chain
- **What to build:** Write a thin `runPipeline(workspace)` that calls monitor →
  picks worst anomaly → diagnose → recommend, emitting a trace event at each
  chain hop so the fixed sequence is visible in Studio as distinct from the
  agent-internal turns.
- **Why it earns its place:** It forces the chain/agent boundary into code — the
  pipeline hops are chain steps, the per-box turns are agent steps, and the trace
  shows both altitudes. Demonstrates you can see the two layers.
- **Files to touch:** a new `packages/agents/*/src/pipeline.ts` (or `apps/studio`
  orchestration), `packages/runtime/src/events.ts` (reuse existing event types).
- **Done when:** A pipeline run produces a trace with labelled chain hops wrapping
  each agent's turn events.
- **Estimated effort:** `1–4hr`

## Interview defense

**Q: When would you NOT use an agent?**
"Whenever I know the steps in advance. I'd sketch the two shapes:"

```
  fixed steps → CHAIN          unknown steps → AGENT
  A ─► B ─► C                  loop: ask model → tool? → loop
  deterministic, cheap         adaptive, must be fenced
```

"If the second step doesn't depend on what the first step *found*, a chain is
strictly better: deterministic, cheaper, debuggable. I reach for an agent only
when the model has to decide the next move from a result I couldn't predict at
author-time. In AptKit the monitor→diagnose→recommend pipeline is a chain; only
the boxes that genuinely investigate are agents."
*Anchor: agents trade determinism for adaptivity — only pay that when you must.*

**Q: Your recommendation agent has `maxTurns: 6`. Doesn't that make it a chain of
6 steps?**
"No — `maxTurns` is a *ceiling*, not a count. The model might answer in 1 turn
with 0 tool calls, or use all 4 tool calls across 3 turns. A chain would say
'call these exact tools in this order.' The agent says 'you have a budget; you
pick.' The number is the fence the code owns; the moves inside it belong to the
model. That's `recommendation-agent.ts:86`."
*Anchor: a budget is not a script — the ceiling is code's, the moves are the model's.*

## Validate

- **Reconstruct:** From memory, draw the two control-flow shapes (chain arrows vs
  agent loop) and label who owns control in each. Check against the Move 1
  diagram.
- **Explain:** Why is `maxToolCalls: 4` (`recommendation-agent.ts:87`) evidence
  of an agent and not a chain? (Because it's an upper bound the model spends as it
  sees fit — a chain would name the exact calls in order.)
- **Apply:** You're asked to build "fetch a customer's lifetime value, format it,
  and return it." Chain or agent, and why? (Chain — the steps are known and
  fixed; an agent adds cost and nondeterminism for no benefit.)
- **Defend:** Why does AptKit keep the orchestration (monitor→diagnose→recommend)
  as a chain instead of one big agent that does all three? (Determinism and
  debuggability at the top level; the loop only appears where runtime
  investigation is genuinely required — `recommendation-agent.ts:64` takes a
  finished `Diagnosis` as input rather than rediscovering it.)

## See also

- [03-react-pattern.md](03-react-pattern.md) — the bounded loop that makes each box an agent
- [02-tool-calling.md](02-tool-calling.md) — what the model's "step" physically is
- [04-tool-routing.md](04-tool-routing.md) — which tools each single-purpose agent may see
- [../02-context-and-prompts/03-prompt-chaining.md](../02-context-and-prompts/03-prompt-chaining.md) — the pipeline as prompt chaining
- [.aipe/study-agent-architecture/](../../study-agent-architecture/) — multi-agent orchestration on top of the loop
