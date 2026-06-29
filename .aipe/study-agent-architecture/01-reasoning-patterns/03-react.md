# ReAct

**Industry term:** ReAct (reason + act), the interleaved reasoning-action loop. *Industry standard.*

## Zoom out, then zoom in

ReAct is the default single-agent pattern and it's the one aptkit actually runs. The mechanics — the Thought-Action-Observation cycle — are walked in the AI-engineering guide. This file's job is *placement*: where ReAct sits in the reasoning-pattern family, and why the strong prior is to start here before anything fancier.

```
  Zoom out — ReAct is the step function aptkit plugs into the loop

  ┌─ Reasoning-pattern family ──────────────────────────────────┐
  │   ★ ReAct ★  ← the baseline; aptkit runs this                │ ← we are here
  │   plan-and-execute · reflexion · tree-of-thoughts            │
  │   (escalations you reach for only when ReAct measurably fails)│
  └───────────────────────────────┬──────────────────────────────┘
                                   │ is the step() in runAgentLoop
  ┌─ Runtime layer ─────────────────▼───────────────────────────┐
  │  the agent loop skeleton (02-agent-loop-skeleton.md)         │
  └──────────────────────────────────────────────────────────────┘
```

Zoom in: aptkit's loop is ReAct. Each turn the model reasons (in its text output), acts (emits a `tool_use`), observes (the tool result comes back as a `tool_result` message), and repeats. There's no separate planning phase, no self-critique pass — just the interleaved cycle, bounded.

## The structure pass

**Layers.** The pattern (ReAct's reason/act/observe) over the kernel (the loop skeleton from the previous file).

**Axis: when to escalate past ReAct?** That's the only question worth holding here, because the mechanics are covered elsewhere.

```
  "should I escalate past ReAct?" — the gate

  Default to ReAct
       │
       ├─ measure: success rate, tool-call accuracy, latency, cost
       │
       └─ escalate ONLY when a specific failure mode is identified
          that ReAct structurally can't address
```

**The seam.** The escalation gate. Crossing it (to plan-and-execute, reflexion, or multi-agent) buys capability at a real cost. Most teams cross it too early.

## How it works

**Use case in aptkit:** every agent. The clearest is `rag-query` — the model reasons "I should search for X," acts (calls `search_knowledge_base`), observes the ranked chunks, then either searches again or answers. The mechanics live in the loop; ReAct is the *shape* of how the model uses each turn.

### Move 1 — the mental model

You know how a `fetch()` has loading → success → error states you react to? ReAct is the same react-to-the-result instinct, except the "fetch" is a tool call the model chose, and the model decides what to do with the result. Reason about what you need, act to get it, observe what came back, decide again.

```
  ReAct — one turn, interleaved

   Thought:  "I need passages about the user's running goals"
      │
      ▼
   Action:   search_knowledge_base({ query: "running goals", top_k: 5 })
      │
      ▼
   Observation: [ranked chunks with citations]
      │
      └──► loop (reason again) or stop (answer)
```

### Move 2 — the walkthrough

**The interleaving is in the message history.** aptkit doesn't have a "ReAct module" — ReAct *emerges* from how the loop threads thoughts and observations through `messages`. The model's reasoning text and its `tool_use` ride in the same assistant turn (`run-agent-loop.ts:124`); the observation comes back as a user turn of `tool_result` blocks (`run-agent-loop.ts:189`). Next turn the model sees its own prior thought *and* the observation, and reasons forward. That threading is ReAct.

**aptkit's ReAct is bounded, not open-ended.** The textbook ReAct loop runs until the model says done. aptkit caps it (`maxTurns`, `maxToolCalls`) and forces a synthesis turn at the budget — see [02-agent-loop-skeleton.md](02-agent-loop-skeleton.md). That's the production version: ReAct with a hard stop.

**Why aptkit starts and stays here.** None of the six capabilities has a measured failure that ReAct can't fix. The recommendation agent doesn't need a separate planning phase — its path is short (gather evidence, propose). rag-query doesn't need branching exploration — one or two retrievals answer most questions. Starting with ReAct and not escalating is the *correct* default, not a missing feature.

### Move 3 — the principle

Default to ReAct. Measure success rate, tool-call accuracy, latency, and cost. Escalate only when you can name the specific failure ReAct can't address. Most teams jump past ReAct prematurely; "I built a ReAct baseline, measured it, and escalated only when [specific failure]" is a stronger answer than reaching for plan-and-execute or multi-agent first.

## Primary diagram

```
  ReAct as aptkit runs it — bounded interleaving

  turn 0   Thought + Action ──► tool ──► Observation ──┐
  turn 1   Thought + Action ──► tool ──► Observation ──┤  accumulating
  turn 2   Thought + Action ──► tool ──► Observation ──┤  in messages[]
    ...                                                │
  budget   forceFinal: tools withheld ──► final answer ◄┘
  hit      (the bounded ReAct stop — 02-agent-loop-skeleton)
```

## Elaborate

ReAct (Yao et al., 2022) won because interleaving reasoning with action beats doing all reasoning up front (which drifts from reality) or all action with no reasoning (which flails). It's the substrate the escalations refine: plan-and-execute pulls the reasoning to the front; reflexion adds a critique pass; tree-of-thoughts branches the reasoning. Knowing ReAct is the baseline is what lets you justify *not* using the fancier ones.

## Interview defense

**Q: What reasoning pattern does aptkit use, and why not something more advanced?**

ReAct, bounded. Every capability interleaves reason-act-observe inside `runAgentLoop`, capped by turn and tool-call budgets. I didn't escalate because none of the capabilities has a measured failure ReAct can't fix — the paths are short and don't need a separate planning phase or a critique loop.

```
  ReAct baseline → measure → escalate only on a named failure
  (aptkit: never crossed that gate; correctly)
```

*Anchor: not escalating is a decision, not a gap — name the measurement that justified staying.*

## See also

- [02-agent-loop-skeleton.md](02-agent-loop-skeleton.md) — the kernel ReAct plugs into.
- [04-plan-and-execute.md](04-plan-and-execute.md) — the first escalation.
- ReAct Thought-Action-Observation mechanics: `.aipe/study-ai-engineering/04-agents-and-tool-use/03-react-pattern.md`.
