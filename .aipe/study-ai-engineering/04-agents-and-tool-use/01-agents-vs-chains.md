# Agents vs Chains
*Agents vs chains · loop vs pipeline (Industry standard)*

Here's the verdict before the explanation, because it's the thing people get backwards: aptkit's "agents" are a model-controlled loop running *inside* a hand-wired pipeline. The pipeline is fixed and you wrote it. The loop is where you hand the steering wheel to the model. Both live in this repo, and the interesting design call is which one you reach for.

A chain is a sequence you decided at authoring time — `monitor().then(diagnose).then(recommend)`. You know every step and the order before any token is generated. An agent is a `while` loop whose *exit condition the model controls*: it keeps calling tools until it decides it's done. That's the whole distinction. Everything else is detail.

## Zoom out, then zoom in

Picture the two control shapes side by side. One is a railroad — you laid the track. The other is a search — the model expands the frontier until it stops.

```
Two control shapes in aptkit
┌──────────────────────────────────────────────────────────────┐
│  CHAIN (you control the order)                                 │
│                                                                │
│   input → [ monitor ] → [ diagnose ] → [ recommend ] → output  │
│              fixed         fixed          fixed                │
│           ── order is code you wrote, model has no say ──      │
├──────────────────────────────────────────────────────────────┤
│  AGENT (model controls the loop)        ★ the steering wheel   │
│                                                                │
│   input → ┌─ runAgentLoop ──────────────────────┐ → output    │
│           │  while(model wants a tool):          │             │
│           │     call tool → feed result back     │             │
│           │  ↑___________________________________│             │
│           └──── model decides when to stop ──────┘             │
└──────────────────────────────────────────────────────────────┘
```

The ★ is the only place control leaves your code. In a chain you'd never let the model pick the next function — you already picked it. In `runAgentLoop` the model picks *every* next move by choosing which tool (if any) to call. aptkit ships both because they're answers to different questions: "do I know the steps?" (chain) vs "do I need the model to figure out the steps?" (agent).

## Structure pass

Trace **control** through both shapes and watch where it flips.

In a chain, control never leaves your process. You call `monitor`, you take its output, you call `diagnose`. The model is invoked *inside* each step as a leaf — it answers a question, it doesn't decide what happens next. Control is yours start to finish.

In an agent, control flips at exactly one seam: the line where you ask the model whether it wants a tool. In `runAgentLoop` that's `const toolUses = toolUsesFromContent(response.content)` (`packages/runtime/src/run-agent-loop.ts:131`). If the model emitted tool-use blocks, *the model* just chose the next action and you obey by dispatching them. If it emitted none, the model chose to stop and you break (`:132-135`). That single branch is the entire difference. Above it, you're driving; below it, the model is.

The thing nobody tells you: aptkit nests them. The five analytics capabilities form a conceptual chain — monitor, then diagnose, then recommend — but *each one is itself an agent loop* that lets the model decide which read-only tools to call to do its part. Fixed pipeline, agentic stages.

## How it works

### Move 1 — the mental model

A chain is a `.then()` you wrote. An agent is a `while` whose condition the model owns. Same data flows through; the difference is who holds the loop condition.

```
The kernel: who owns the loop condition?
┌─────────────────────────────┬──────────────────────────────────┐
│ CHAIN                       │ AGENT (runAgentLoop)               │
│                             │                                    │
│ for (step of MY_STEPS) {    │ for (turn=0; turn<maxTurns;turn++){│
│   result = step(result)     │   resp = await model.complete(..)  │
│ }                           │   if (no tool_use) break  ◄── model│
│  ▲                          │   for (use of toolUses)            │
│  │ I wrote MY_STEPS         │     callTool(use)         ◄── model│
│  └ order is static          │ }                          chose   │
└─────────────────────────────┴──────────────────────────────────┘
```

The `break` and the tool dispatch are both driven by `response.content`, which is the model's output. That's the inversion.

### Move 2 — the moving parts

**The fixed half: the pipeline you wrote.** The RAG query agent's `answer()` is a tiny chain: list tools, filter them by policy, then run the loop. You authored that order.

```
answer() — a 3-step chain you control, ending in an agent loop
  listTools ──► filterToolsForPolicy ──► runAgentLoop
   (yours)          (yours)              (model's loop)
```

```ts
// packages/agents/rag-query/src/rag-query-agent.ts:62-80
async answer(question: string, runOptions: RagQueryRunOptions = {}): Promise<string> {
  const allTools = await this.options.tools.listTools();              // step 1 (you)
  const toolSchemas = filterToolsForPolicy(allTools, ragQueryToolPolicy); // step 2 (you)
  const { finalText } = await runAgentLoop({                          // step 3 → model takes over
    capabilityId: RAG_QUERY_CAPABILITY_ID,
    model: this.options.model,
    tools: this.options.tools,
    system: this.system,
    userPrompt: question,
    toolSchemas,
    maxTurns: 6,        // ◄── the loop is BOUNDED — model can't run forever
    maxToolCalls: 4,
    synthesisInstruction: buildSynthesisInstruction(/* ... */),
  });
  return finalText.trim() || FALLBACK_ANSWER;
}
```

The first two lines are a chain. The third hands control to the model — but bounded by `maxTurns: 6` and `maxToolCalls: 4`. That's the staff-engineer move: you give the model the wheel, but you bolt the brakes on yourself.

**The agentic half: the loop condition the model owns.** Inside `runAgentLoop`, the model's output decides whether the loop continues.

```ts
// packages/runtime/src/run-agent-loop.ts:131-135
const toolUses = toolUsesFromContent(response.content);
if (toolUses.length === 0) {   // model emitted no tool → model chose to stop
  finalText = text;
  break;
}
// otherwise: dispatch every tool the model asked for, loop again
```

No tool uses means the model is done. Tool uses mean keep going. Your code never decides "we've done enough"; the model does (within the budget you set).

### Move 3 — the principle

Reach for a chain when you know the steps. Reach for an agent when you need the model to discover the steps from the data. aptkit doesn't pick one religiously — it wraps agent loops in a fixed pipeline so the *macro* flow is predictable and auditable while the *micro* decisions inside each stage stay flexible. Predictability on the outside, flexibility on the inside.

## Primary diagram

```
aptkit's real shape: agent loops nested in a fixed pipeline
┌────────────────────────────────────────────────────────────────────┐
│ FIXED PIPELINE  (you wrote this order — a chain)                     │
│                                                                      │
│  ┌────────────┐   ┌────────────┐   ┌────────────┐                   │
│  │  monitor   │──►│  diagnose  │──►│ recommend  │                    │
│  │ capability │   │ capability │   │ capability │                    │
│  └─────┬──────┘   └─────┬──────┘   └─────┬──────┘                   │
│        │                │                │                          │
│   each box is itself:   ▼                                           │
│   ┌───────────────────────────────────────┐                        │
│   │ runAgentLoop  (model controls the loop)│                        │
│   │  complete → tool_use? → callTool → ↑   │                        │
│   │  break when model emits no tool        │                        │
│   │  bounded: maxTurns / maxToolCalls      │                        │
│   └───────────────────────────────────────┘                        │
└────────────────────────────────────────────────────────────────────┘
```

## Elaborate

The honest gap: aptkit's pipeline-of-agents is *conceptual*, not enforced by a single orchestrator object — the five analytics agents share a shape (`*_CAPABILITY_ID` + read-only allowlist + bounded `runAgentLoop` + validator) but are invoked independently, not chained by a top-level `Pipeline` class. So "aptkit has both" is true at the level of patterns: the loop is real and shipped; the chain is the convention you compose them with. If you wanted a hard chain, you'd write the `.then()` yourself around these `answer()` calls.

## Project exercises

### Document the chain-vs-agent decision on a capability

- **Exercise ID:** `EX-AGENT-01a`
- **What to build:** A short decision note (JSDoc block or inline comment) on the RAG query agent's `answer()` explaining *why* it's an agent loop and not a fixed chain — i.e. the model must decide whether one search is enough or whether to refine and search again. This is the Phase 4 "name your control shape" rep.
- **Why it earns its place:** Forces you to articulate the inversion-of-control seam out loud, which is exactly the thing an interviewer probes when they ask "why an agent here?"
- **Files to touch:** `packages/agents/rag-query/src/rag-query-agent.ts`
- **Done when:** The note names the loop condition (model emits no tool → stop) and states the alternative (a 1-shot chain) and why it loses (no refinement).
- **Estimated effort:** `<1hr`

## Interview defense

**Q: aptkit calls these "agents" — but the analytics ones run a fixed monitor→diagnose→recommend sequence. Isn't that just a chain?**

```
The sequence is fixed; each STAGE is an agent.
  monitor → diagnose → recommend     ← chain (you wrote the order)
     └─ each = runAgentLoop          ← agent (model picks tools inside)
```

A: The macro order is a chain — I wrote it. But inside each stage the model decides which read-only tools to call and when to stop, bounded by `maxTurns`/`maxToolCalls`. Fixed pipeline, agentic stages. Anchor: the `break` at `run-agent-loop.ts:132` is owned by the model's output, not my code.

**Q: When would you NOT use an agent loop?**

```
known steps → chain        unknown steps → agent
   cheap, auditable           flexible, costs tokens per turn
```

A: When I already know the steps. A loop pays a model round-trip per turn and can wander; a chain is one pass, cheaper, and trivially auditable. I only spend the loop when the model genuinely needs to discover the path — like deciding whether retrieved chunks are sufficient or it needs another query.

## See also

- [02-tool-calling.md](02-tool-calling.md) — how the model actually asks for a tool inside the loop.
- [03-react-pattern.md](03-react-pattern.md) — the loop traced as Thought-Action-Observation.
- [06-error-recovery.md](06-error-recovery.md) — the brakes (`maxTurns`/`maxToolCalls`) that keep the loop bounded.
