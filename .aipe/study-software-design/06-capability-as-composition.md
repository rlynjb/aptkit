# 06 — Capability as Composition

**Subtitle:** Layering by composition · an agent = prompt package + tool policy +
loop config + validator, assembled — *Project-specific* (every aptkit agent is
this shape; the RAG agent is the 6th instance).

---

## Zoom out, then zoom in

An agent in aptkit isn't a monolith with retrieval, prompting, and a control loop
tangled together. It's four smaller, independently-deep parts wired into one
`answer()` method. Each part is reusable on its own; the agent is the wiring.

```
  Zoom out — where a capability sits, and what it's made of

  ┌─ Agent (a capability) ─────────────────────────────────────────┐
  │  RagQueryAgent.answer(question)                                 │
  │   = injectProfile(prompt)  +  filterToolsForPolicy(policy)      │
  │     +  runAgentLoop(config)  +  (parseResult validator)         │
  └──┬──────────────┬───────────────────┬──────────────────┬─────────┘
     │ prompts       │ tools             │ runtime           │ runtime
  ┌──▼────┐    ┌─────▼──────┐     ┌──────▼───────┐   ┌───────▼────────┐
  │prompt  │    │ ToolPolicy │     │ runAgentLoop │   │ parseResult /  │
  │package │    │ +filter    │     │ (the loop)   │   │ recoveryPrompt │
  └────────┘    └────────────┘     └──────────────┘   └────────────────┘
```

Zoom in: the concept is **layering by composition** — building a higher-level
capability by combining lower-level modules, each of which hides its own
complexity (the prompt template hides `{var}` substitution; the policy hides
allowlisting; the loop hides the ReAct turn machinery). The agent layer adds the
one thing none of the parts can do alone: *orchestrate them for one task.* The
question it answers: how do you get six different agents without six
copy-pasted control loops?

---

## Structure pass

- **Layers:** the agent (`answer`) → the four composed parts → the runtime/tools
  primitives underneath.
- **Axis — "who decides control flow?":** trace it down (this is the agent
  layering's whole lesson).
  - agent `answer()` → **decides the *recipe*:** which prompt, which policy,
    `maxTurns: 6`, `maxToolCalls: 4`, the synthesis instruction
    (`rag-query-agent.ts:66-80`). Fixed orchestration.
  - `runAgentLoop` → **decides *each turn*:** call the model, run tools, force a
    final answer on the last turn (`run-agent-loop.ts:98-190`). The LLM chooses
    within the loop's rules.
  - tool handler → **just runs.** No control; returns ranked hits.
- **Seam:** the `runAgentLoop(options)` call. Control flips from *agent-fixed*
  (the recipe) above it to *LLM-driven* (per-turn choice) inside it. The agent
  constrains; the loop chooses freely within the constraints.

---

## How it works

### Move 1 — the mental model

You compose React components this way every day: a `<SearchPage>` doesn't
reimplement input handling and data fetching — it composes `<SearchInput>`,
`useQuery`, and `<Results>`, adding only the wiring that makes them one page. An
aptkit agent is a `<SearchPage>` for LLM work: it composes four reusable parts and
adds only the orchestration recipe.

```
  Pattern — assemble four parts into one answer()

   profile ─┐
   prompt ──┼─► injectProfile + renderTemplate ─► system string
            │
   policy ──┼─► filterToolsForPolicy(allTools) ──► tool schemas
            │
            ▼
        runAgentLoop({ system, toolSchemas, maxTurns, maxToolCalls,
                       synthesisInstruction, trace })
            │
            ▼
        finalText  (── parseResult? ── structured T)
```

The strategy: **the agent owns the recipe (which parts, which budgets); the parts
own their own complexity; the loop owns the turns.**

### Move 2 — the step-by-step walkthrough

**Part assembly happens in the constructor.** The prompt is built once — profile
injected, then template rendered:

```ts
// packages/agents/rag-query/src/rag-query-agent.ts:52-59
constructor(private readonly options: RagQueryAgentOptions) {
  const template = options.prompt ?? DEFAULT_SYSTEM_TEMPLATE;
  const withProfile = options.profile
    ? injectProfile(template, options.profile, { position: 'start', heading: PROFILE_HEADING })
    : template;
  this.system = renderPromptTemplate(withProfile, {});   // two @aptkit packages, composed
}
```

`injectProfile` (from `@aptkit/context`) and `renderPromptTemplate` (from
`@aptkit/prompts`) are each pure string→string functions hiding their own work.
The agent just orders them: inject first, render second.

**The policy is data, applied at call time.** Least-privilege is a 2-line const,
not a class:

```ts
// rag-query-agent.ts:15-18, 63-64
export const ragQueryToolPolicy: ToolPolicy = {
  capabilityId: RAG_QUERY_CAPABILITY_ID,
  allowedTools: [SEARCH_KNOWLEDGE_BASE_TOOL_NAME],   // this agent may ONLY search
};
// ...inside answer():
const allTools = await this.options.tools.listTools();
const toolSchemas = filterToolsForPolicy(allTools, ragQueryToolPolicy);  // narrow the grant
```

The registry can hold 49 tools; this agent sees one. `filterToolsForPolicy`
(`tool-policy.ts:11`) is the thin pure function from `audit.md` lens 2 — thin on
purpose, because policy-as-data composes better than policy-as-object.

**The loop call is the composition's center.** All four parts meet here:

```ts
// rag-query-agent.ts:66-80
const { finalText } = await runAgentLoop({
  capabilityId: RAG_QUERY_CAPABILITY_ID,
  model: this.options.model,             // ← the deep provider module (file 01)
  tools: this.options.tools,
  system: this.system,                   // ← composed prompt
  userPrompt: question,
  toolSchemas,                           // ← filtered by policy
  trace: this.options.trace,             // ← passed straight to the sink (file 05)
  maxTurns: 6,
  maxToolCalls: 4,
  synthesisInstruction: buildSynthesisInstruction(
    'Now answer the question directly and concisely, citing the sources you retrieved.'),
});
```

```
  Layers-and-hops — control altitude flips at the loop boundary

  ┌─ Agent (recipe, FIXED) ──────────────────────────────────────────┐
  │ pick prompt+policy, set maxTurns=6, maxToolCalls=4, synthesis text │
  └────────────────────────────┬───────────────────────────────────────┘
              runAgentLoop(...) │  ← control FLIPS here
  ┌─ Loop (per-turn, LLM-DRIVEN within rules) ──▼─────────────────────┐
  │ turn: model.complete() → tool_use? run tool, loop : final, break   │
  │ last turn / budget spent → force final answer (no tools)           │
  └────────────────────────────┬───────────────────────────────────────┘
              tools.callTool()  │  ← control flips again
  ┌─ Tool (just runs) ──────────▼───────────────────────────────────────┐
  │ search_knowledge_base → ranked hits + citations                      │
  └────────────────────────────────────────────────────────────────────┘
```

**The validator is the optional fifth part.** The RAG agent returns plain text,
so it skips it — but the structured agents (recommendation, diagnostic) pass a
`parseResult` and a `recoveryPrompt` to `runAgentLoop` (`run-agent-loop.ts:48-49,
192-199`), so a failed parse triggers one recovery turn. Composition means each
agent opts into exactly the parts it needs: RAG takes four, the structured agents
take five.

**Why this is layering and not a pass-through.** A pass-through would be an
`answer()` that just calls `runAgentLoop` and returns. This one *adds*: it
composes the system prompt from two packages, narrows 49 tools to 1 via policy,
sets the turn/tool budgets, supplies the synthesis instruction, and applies the
`FALLBACK_ANSWER` when the loop returns empty (`rag-query-agent.ts:82`). Six
agents share the loop; each supplies a different recipe. That's the leverage —
`run-agent-loop.ts` is written once.

### Move 3 — the principle

Composition is how you get many capabilities from few modules: keep each part
deep and reusable, and let the higher layer add *only* the orchestration. The
test that you composed rather than coupled is the one `context.md` states
plainly — the RAG agent is the *6th* instance of "prompt + policy + loop +
validator" with no new control-flow code. When the Nth instance costs only a
recipe, the layering is right.

---

## Primary diagram

```
  Capability as composition — full picture (RagQueryAgent)

  ┌─ @aptkit/context ─┐  ┌─ @aptkit/prompts ─┐   inject + render
  │ injectProfile     │  │ renderPromptTemplate│ ─────────────► system string
  └───────────────────┘  └─────────────────────┘
  ┌─ @aptkit/tools ───┐   filterToolsForPolicy(allTools, ragQueryToolPolicy)
  │ ToolPolicy (data) │ ─────────────────────────────────────► [search_knowledge_base]
  └───────────────────┘
                              ▼ all parts meet at the loop call
  ┌─ @aptkit/runtime: runAgentLoop ───────────────────────────────────────┐
  │ system + toolSchemas + model (provider) + trace (sink)                 │
  │ maxTurns 6 · maxToolCalls 4 · synthesisInstruction · parseResult?      │
  │   loop: complete → tool_use? run : final → break ; force-final on last │
  └────────────────────────────┬───────────────────────────────────────────┘
                               ▼
                       finalText.trim() || FALLBACK_ANSWER
   (the 6th agent of this exact shape — zero new control-flow code)
```

---

## Elaborate

This is "deep modules, composed" — the payoff of every other file in this guide.
Files 01–05 each made one part deep (provider, emulation, retrieval contract,
guard-railed tool, trace sink). This file is where they get *assembled* into a
working capability without any of them leaking into the others. The reason it
matters: agent frameworks rot when control flow gets copy-pasted per agent —
six slightly-different loops that drift apart. aptkit has one loop and six
recipes, so a fix to turn-budget logic (or the synthesis-instruction behaviour)
lands once and every agent gets it.

The honest note: the only smell here is the `capabilityId` pass-through variable
(`audit.md` lens 4) — threaded from each agent's const through the loop into
every trace event purely to be forwarded. It's load-bearing at the trace
consumer, and the alternative (a context object) is heavier, so it stays. That's
the cost of flat, explicit tracing, accepted deliberately.

Adjacent: `../study-agent-architecture/` walks the *reasoning* side of the loop
(ReAct, the forced synthesis turn); this file is the *module-composition* side.

---

## Interview defense

**Q: How do you get six agents without six control loops?**

Composition. Each agent is `prompt package + tool policy + loop config +
validator` assembled into one `answer()`. The control loop (`runAgentLoop`) is
written once; each agent supplies a recipe — which prompt, which tool allowlist,
the turn and tool-call budgets, the synthesis instruction, and optionally a
result validator. The RAG agent is the sixth instance and adds zero new
control-flow code.

```
  one runAgentLoop  ◄── recipe ── RagQueryAgent (prompt+policy+budgets)
                    ◄── recipe ── recommendation (+ parseResult)
                    ◄── recipe ── diagnostic, query, monitoring, rubric
```

**Q: How is this layering and not a pass-through wrapper?**

A pass-through would just forward to `runAgentLoop`. This one *adds*: composes
the system prompt from two packages (`injectProfile` then `renderPromptTemplate`),
narrows 49 registry tools to 1 via a policy applied at call time, sets
`maxTurns`/`maxToolCalls`, supplies the synthesis instruction, and falls back to
a canned answer on empty output. The value added at the layer is the
orchestration recipe — that's composition.

*Anchor:* "Agent = prompt + policy + loop + validator, composed. One loop, six
recipes — the Nth agent costs a recipe, not a control loop. Control flips from
agent-fixed to LLM-driven exactly at the `runAgentLoop` call."

---

## See also

- `01-deep-provider-module.md` — the `model` part composed in here.
- `04-guard-rails-as-information-hiding.md` — the `search_knowledge_base` tool the
  policy grants.
- `05-injectable-trace-seam.md` — the `trace` part passed through; the
  `capabilityId` pass-through variable.
- `audit.md` — lens 4 (layering, the one pass-through variable), lens 2 (policy
  as a correctly-thin module).
- `../study-agent-architecture/` — the loop's reasoning patterns.
