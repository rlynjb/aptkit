# 01 — Chains vs Agents

*Chain / agent boundary — Industry standard (LangChain coined "chain"; the
chain-vs-agent split is now language-agnostic vocabulary).*

## Zoom out, then zoom in

Before you decide *what* shape an LLM workflow takes, look at where that
decision sits in AptKit and what it constrains downstream.

```
  Where the chain/agent decision sits

  ┌─ App / Studio (apps/studio) ─────────────────────────────┐
  │  one button click = one capability run                   │
  └───────────────────────────┬──────────────────────────────┘
                              ▼
  ┌─ Capability (packages/agents/*) ─────────────────────────┐
  │  scan() / investigate() / propose() / answer()           │
  │  ★ CHAIN-OR-AGENT? you choose here, once, per capability ★│ ← we are here
  └───────────────────────────┬──────────────────────────────┘
                              ▼
  ┌─ Kernel (packages/runtime/run-agent-loop.ts) ────────────┐
  │  the loop that runs only because the answer was "agent"  │
  └───────────────────────────┬──────────────────────────────┘
                              ▼
  ┌─ Tools (packages/tools) ─────────────────────────────────┐
  │  analytics queries the loop fires on demand              │
  └──────────────────────────────────────────────────────────┘
```

That one decision — chain or agent — is the most consequential architectural
choice in the whole stack, and it's made implicitly. Here's the thing you
already know from frontend, restated: a **chain is a `.then()` chain you wrote
by hand.** You decided, at code-authoring time, "fetch the user, *then* fetch
their orders, *then* render." Three steps. Always three. The number of steps is
a fact about your *code*, not about the *data*. An **agent is a `while` loop
where the model decides the next step each iteration**, and crucially *decides
when to stop.* You did not write the step count. You wrote the *budget*. The
model spends it.

The reason this matters for AptKit: when you investigate why conversion dropped,
you don't know in advance whether the answer takes one query or five. Maybe the
first query shows it's mobile-only and you're done. Maybe it's a campaign that
ended, and you need three more queries to confirm. The step count *depends on
what the model finds.* You cannot write that as a `.then()` chain without
writing every branch. So AptKit chose agents.

## Structure pass

Trace the **control axis** — "who decides the next step" — down the layers.

```
  The control axis: who picks the next step

  Layer              Who decides "what runs next"      Step count known when?
  ─────────────────  ────────────────────────────────  ──────────────────────
  Chain (hand-coded) YOU, at author time                compile time   ← fixed
  ─ ─ ─ ─ ─ ─ ─ ─ ─  ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─  ─ ─ ─ ─ ─ ─ ─ ─ ◄ SEAM
  Agent loop         THE MODEL, each turn               runtime         ← variable
```

The seam is exactly where control flips from *you* to *the model*. Above the
dashed line, a human author wrote the order and it never changes. Below it, the
model emits a tool-use intent and the harness obeys, turn after turn, until the
model stops emitting intents. Everything hard about agents — non-determinism,
budgets, forced termination, the need to validate output — lives below that
seam, because that's where you gave up knowing the step count in advance.

## How it works

### Move 1 — the mental model

A chain is a pipeline whose nodes are fixed; an agent is a loop whose body is
"ask the model, do what it says, feed the result back."

```
  Chain (fixed) vs Agent (model-driven)

  CHAIN                              AGENT
  ┌──────┐                           ┌─────────────────────────────┐
  │step A│                           │  ask model ──▶ tool intent? │
  └──┬───┘                           │     ▲              │ yes     │
     ▼                               │     │              ▼         │
  ┌──────┐   author wrote            │     │         run tool       │
  │step B│   this order              │     │              │         │
  └──┬───┘                           │     └──────────────┘         │
     ▼                               │           feed result back   │
  ┌──────┐                           │                  │ no intent │
  │step C│                           │                  ▼           │
  └──────┘                           │            final answer      │
  done after 3, always               └─────────────────────────────┘
                                     done after N, where MODEL picks N
```

### Move 2 — the moving parts

**The fixed-vs-variable step count**

```
  chain:  steps = 3                  (a constant in your source)
  agent:  steps = ?  bounded by budget, chosen by the model at runtime
```

In a chain you write `await a(); await b(); await c();`. The `3` is in the
source. In an agent you write `for (turn = 0; turn < maxTurns; turn++)` and the
model decides whether each turn calls a tool or finishes. The literal in the
source is now a *ceiling*, not a *count*.

**The decision authority**

```
  chain author:  "I know the steps. I encode them."
  agent author:  "I don't know the steps. I give the model tools + a budget."
```

You reach for an agent precisely when you cannot enumerate the branches. If you
*can* enumerate them, a chain is cheaper, faster, deterministic, and easier to
test — don't reach for an agent out of fashion.

**The cost of the flip**

```
  what you gain:  handles unknown-length problems
  what you pay:   non-determinism, token cost per turn, must bound the loop,
                  must validate output (the model can return garbage)
```

### Move 3 — the principle

Choose an agent only when the step count is a property of the *data*, not of
the *code*. If you can write the steps down, write them down.

## Primary diagram

The full picture: one decision, made once per capability, that determines
whether control stays with you or moves to the model.

```
  Chain vs Agent — the one decision and its consequences

   Can you enumerate the steps in advance?
              │
        ┌─────┴─────┐
       YES          NO
        │            │
        ▼            ▼
   ┌─────────┐  ┌──────────────────────────────────┐
   │  CHAIN  │  │  AGENT (runAgentLoop)             │
   │ .then() │  │  for turn in 0..maxTurns:         │
   │ fixed N │  │    model picks tool or finishes   │
   │ no loop │  │    harness runs tool, feeds back  │
   └─────────┘  │  model picks N, bounded by budget │
                └──────────────────────────────────┘
   cheap,         handles unknown depth,
   deterministic  costs tokens + non-determinism
```

AptKit took the right branch for analytics investigation: the step count is a
property of the data.

## Implementation in codebase

**Use case: scanning for anomalies.** You don't know how many analytics queries
prove a checkout drop is real — one if it's obvious, five if you have to rule
out segments, campaigns, and seasonality. So `scan()` is an agent, not a chain.

`packages/agents/anomaly-monitoring/src/monitoring-agent.ts:57` — `scan()`
hands the model a tool policy and a budget, then delegates the loop:

```ts
// monitoring-agent.ts:66-83  — the "agent" branch in code form
const { parsed } = await runAgentLoop<Anomaly[]>({
  capabilityId: ANOMALY_MONITORING_CAPABILITY_ID,
  model: this.options.model,        // ← the decider
  tools: this.options.tools,        // ← what it may run
  system, userPrompt,
  toolSchemas,                      // ← the menu the model picks from each turn
  maxTurns: 8,                      // ← the ceiling, NOT the step count
  maxToolCalls: 6,                  // ← second ceiling (see 02-agent-loop-skeleton)
  // ...
});
```

Note what is *absent*: there is no `await queryA(); await queryB();`. The number
of queries is decided inside `runAgentLoop`, turn by turn, by the model.

The actual loop — the literal `for` that makes this an agent and not a chain —
is `packages/runtime/src/run-agent-loop.ts:98`:

```ts
// run-agent-loop.ts:98 — the loop body the model drives
for (let turn = 0; turn < maxTurns; turn += 1) {
  // ask model; if it emits no tool_use, break (success exit, line 132-135)
  // else run the tools and loop again
}
```

Contrast: the intent classifier at `packages/agents/query/src/intent.ts:12`
(`classifyIntent`) is *not* an agent — it's a single `model.complete` call with
no loop, no tools, `maxTokens: 16`. That's a one-shot chain step. The repo uses
both shapes deliberately: a loop where depth is unknown, a single call where the
job is "classify into one word." See `07-routing.md`.

## Elaborate

**Origin.** "Chain" entered the vocabulary via LangChain (2022) as a name for
composed LLM calls. "Agent" predates LLMs by decades in AI, but the modern
LLM-agent sense — a loop where the model picks tools — crystallized around the
ReAct paper (2022). The chain/agent distinction is now language-agnostic
interview vocabulary regardless of framework.

**Adjacent concepts.** A *chain with a conditional* (route to branch A or B,
each fixed) is still a chain — one decision, then fixed steps; that's
`07-routing.md`. A *chain that loops a fixed number of times* (map over 10 items)
is still a chain — the count is in your code. The line is strictly: did the
*model* choose how many steps? Not "is there a loop."

## Interview defense

**Q: "When would you NOT use an agent?"**

```
  Decision tree you defend out loud

  step count enumerable?  ──YES──▶  chain   (cheaper, deterministic, testable)
          │
          NO
          ▼
  steps depend on model's findings?  ──YES──▶  agent (pay for it knowingly)
```

Anchor: "If I can write the `.then()` chain, I write the chain — an agent is
what I reach for when the data, not my code, decides the step count."

**Q: "What does choosing an agent cost you?"**

```
  the bill for moving control to the model

  determinism   ─lost─▶  must test against behavior, not exact output
  step count    ─lost─▶  must add a budget (maxTurns / maxToolCalls)
  output trust  ─lost─▶  must parse + validate (model can return garbage)
```

Anchor: "The loop is the easy part; the budget and the output validator are the
tax you pay for not knowing the step count."

The load-bearing skeleton part this surfaces: the *budget* exists only because
you chose an agent — it's the price of the flipped control axis. That budget is
the subject of the next file.

## Validate

- **Reconstruct:** Without looking, draw the chain-vs-agent decision tree.
  Where in `monitoring-agent.ts` is the "agent" branch taken? (line 66, the
  `runAgentLoop` call).
- **Explain:** Why is `intent.ts:12` `classifyIntent` a chain step and not an
  agent? (one `model.complete`, no loop, no tools).
- **Apply:** Given a new task — "summarize the 3 highest-severity anomalies" —
  is that a chain or an agent? (chain: you know the steps — scan, sort, take 3,
  summarize; the sort+slice at `monitoring-agent.ts:86-88` is literally a
  hand-coded chain step bolted onto the agent's output).
- **Defend:** Argue against a teammate who wants to make `classifyIntent` an
  agent loop. (It classifies into one of three words; the step count is one;
  adding a loop adds cost and non-determinism for zero gain.)

## See also

- [02-agent-loop-skeleton.md](02-agent-loop-skeleton.md) — the loop you get when
  you take the agent branch
- [03-react.md](03-react.md) — the specific agent shape all five AptKit
  capabilities use
- [07-routing.md](07-routing.md) — a chain-with-a-conditional (still a chain)
- `../agent-patterns-in-this-codebase.md` — the patterns table
