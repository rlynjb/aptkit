# Capability as Composition

**Industry name(s):** composition over inheritance / dependency injection
/ assembly root · **type:** Industry standard

An agent in AptKit isn't a subclass or a monolith — it's a handful of
ports wired together by injection. `RagQueryAgent` is the clearest case:
a model port, a tool registry, a profile string, and a least-privilege
policy, composed through one generic loop. The agent itself holds almost
no logic — it's an assembly of deeper modules. That's why a sixth agent
costs a config object, not a new framework.

---

## Zoom out, then zoom in

Here's an agent from the top. The box labeled `RagQueryAgent` is thin —
it injects three things into the generic `runAgentLoop` and trims the
result. All the depth lives in the ports it composes.

```
  Zoom out — an agent is an assembly of injected ports

  ┌─ Capability layer ★ ───────────────────────────────────────────┐
  │ RagQueryAgent — composes:                                       │  ← we are here
  │   A) model      (a ModelProvider — e.g. guarded Gemma)          │
  │   B) tools      (a ToolRegistry holding search_knowledge_base)  │
  │   C) profile    (me.md text, injected into the system prompt)   │
  │   + policy      (least-privilege allowlist)                     │
  └────────────────────────────┬──────────────────────────────────┘
                               │ runAgentLoop({ model, tools, ... })
  ┌─ Generic loop ─────────────▼──────────────────────────────────┐
  │ runAgentLoop — vendor-neutral ReAct loop, the only control flow │
  └────────────────────────────┬──────────────────────────────────┘
  ┌─ Ports ────────────────────▼──────────────────────────────────┐
  │ ModelProvider · ToolExecutor · (search tool over VectorStore)  │
  └─────────────────────────────────────────────────────────────────┘
```

Zoom in: the concept is **composition** — building a capability by
assembling existing deep modules rather than writing new logic. The
question: *how do you add a new agent without growing the framework?*
Answer: make the agent a thin assembly root that injects ports into a
shared loop, and the new agent is just a new wiring.

---

## The structure pass

**Layers.** Capability (the agent) → generic loop (`runAgentLoop`) →
ports (model, tools).

**Axis — trace `control` (who decides what the agent does?).**

```
  One axis: "who decides control flow?" — trace it down

  ┌─ capability (RagQueryAgent) ─┐  CODE decides the wiring + policy
  └──────────────────────────────┘
      ┌─ generic loop (runAgentLoop) ─┐  CODE decides turn budget,
      └────────────────────────────────┘  forced synthesis, order
          ┌─ tool call ───────────────┐  the MODEL decides when/what
          └────────────────────────────┘  to search (within the loop)
   answer flips at each altitude — that contrast is the lesson
```

**Seam.** The agent/loop boundary is load-bearing because what's
*composed* (ports, policy, prompt) is separated from what's *generic*
(the loop). The agent supplies the parts; the loop supplies the control.
Swap any part — the model, the tools, the profile — without touching the
loop.

---

## How it works

### Move 1 — the mental model

You've built a React component that's basically composition — it takes
children, a data hook, and a render prop, and it *arranges* them without
owning much logic itself. `RagQueryAgent` is that for an agent: it takes
a model, a registry, and a profile, arranges them into a loop call, and
trims the output. The depth is in the injected parts, not the agent.

```
  Pattern — the assembly root: inject parts, call the generic engine

   { model, tools, profile }  ─►  RagQueryAgent
                                       │ injects into
                                       ▼
                                  runAgentLoop  (the generic engine)
                                       │ uses
                                       ▼
                              ModelProvider + ToolExecutor (ports)
```

### Move 2 — the step-by-step walkthrough

**Step 1 — the parts arrive by injection, named.** The constructor takes
the three packages explicitly (`rag-query-agent.ts:33–43`):

```ts
export type RagQueryAgentOptions = {
  model: ModelProvider;   // Package A — the model (e.g. a guarded Gemma)
  tools: ToolRegistry;    // Package B — registry holding search_knowledge_base
  profile?: string;       // Package C — me.md text injected into the prompt
  prompt?: string;
  trace?: CapabilityTraceSink;
};
```

Nothing is constructed inside — the caller injects a `ModelProvider` and
a `ToolRegistry`, both ports. The agent doesn't know if the model is
Gemma or a fixture, or whether the store behind the tool is in-memory or
pgvector. (DI, straight from the PATTERN VOCABULARY.)

**Step 2 — the prompt is composed, not hard-coded.** The system prompt is
assembled at construction (`rag-query-agent.ts:52–59`): inject the
profile via `injectProfile`, then resolve template placeholders via
`renderPromptTemplate`. Two pure functions from two other packages
(`@aptkit/context`, `@aptkit/prompts`) composed into one string. The
agent owns the *order* (profile then render), not the mechanism.

**Step 3 — least-privilege is a composed policy, not code.** The agent
declares what it may touch as data (`rag-query-agent.ts:14–18`):

```ts
export const ragQueryToolPolicy: ToolPolicy = {
  capabilityId: RAG_QUERY_CAPABILITY_ID,
  allowedTools: [SEARCH_KNOWLEDGE_BASE_TOOL_NAME],
};
```

Then `filterToolsForPolicy(allTools, ragQueryToolPolicy)`
(`:64`) trims the registry to just that one tool before the loop sees it.
The permission boundary is a declarative allowlist composed in, not
branching logic inside the agent.

**Step 4 — the only control flow is borrowed.** `answer()` calls
`runAgentLoop` with the composed parts plus a few config knobs
(`rag-query-agent.ts:66–80`): `maxTurns: 6`, `maxToolCalls: 4`, and a
`synthesisInstruction` forcing a final grounded answer. The agent writes
*no loop* — the ReAct control flow lives once, in `runAgentLoop`, and
every agent borrows it. The agent's own body is config + a `.trim()`
fallback (:82).

```
  Layers-and-hops — one answer() call assembles the parts

  ┌─ Caller ─────────┐  new RagQueryAgent({ model, tools, profile })
  │                  │ ──────────────────────────────────┐
  └──────────────────┘                                    ▼
  ┌─ Capability ─────────────────────────────────────────────────┐
  │ RagQueryAgent.answer(q):                                      │
  │  hop 1: listTools() → filterToolsForPolicy (least-privilege)  │
  │  hop 2: runAgentLoop({ model, tools, system, toolSchemas })   │
  └──────────────────────────┬────────────────────────────────────┘
  ┌─ Generic loop ───────────▼────────────────────────────────────┐
  │ runAgentLoop: model.complete ↔ tools.callTool, budget-bounded  │
  └─────────────────────────────────────────────────────────────────┘
```

### Move 2 variant — the load-bearing skeleton

1. **Kernel:** inject ports (model + tools) + compose a prompt from pure
   functions + declare a policy as data + delegate all control flow to a
   shared loop. The agent = wiring + config, no new logic.

2. **What breaks if removed:**
   - Construct the model/tools *inside* the agent → the agent now names
     vendors; you've lost the port, and you can't test with a fixture or
     swap to pgvector. The composition collapses into a monolith.
   - Put the loop *in the agent* → every agent reimplements turn budgets,
     forced synthesis, abort handling; six agents means six loops to keep
     correct. (The repo has six capabilities sharing one loop — that's
     the payoff.)
   - Hard-code the tool list instead of a policy → least-privilege
     becomes a comment; a prompt-injected model could reach tools it
     shouldn't.

3. **Skeleton vs hardening:** the kernel is inject + compose + delegate.
   The `synthesisInstruction`, `maxToolCalls` budget, and `trace` are
   hardening — they make the agent robust and observable, not functional.

### Move 3 — the principle

When the framework is a set of deep modules, a new feature is an act of
*composition*, not construction. The test of whether your abstractions
are right is the cost of the next instance: if a sixth agent needs a new
base class or a forked loop, the abstractions failed; if it needs a
config object and a policy, they succeeded. AptKit's sixth agent
(`rag-query`) is the latter — proof the agent shape is a composition, not
a class hierarchy.

---

## Primary diagram

```
  Capability as composition — full recap

  ┌─ Capability: RagQueryAgent (thin assembly root) ────────────────┐
  │  INJECT   { model: ModelProvider, tools: ToolRegistry }         │
  │  COMPOSE  injectProfile → renderPromptTemplate → system prompt  │
  │  POLICY   ragQueryToolPolicy (allowlist: [search_knowledge_base])│
  │  DELEGATE runAgentLoop({ ...composed, maxTurns:6, maxToolCalls:4})│
  │  TRIM     finalText.trim() || FALLBACK_ANSWER                    │
  └────────────────────────────┬───────────────────────────────────┘
                               │ all control flow borrowed
  ┌─ Generic loop: runAgentLoop ▼──────────────────────────────────┐
  │  model.complete() ↔ tools.callTool(), budget-bounded ReAct      │
  └────────────────────────────┬───────────────────────────────────┘
  ┌─ Ports ────────────────────▼───────────────────────────────────┐
  │ ModelProvider (Gemma/Fixture) · ToolExecutor (search→VectorStore)│
  └─────────────────────────────────────────────────────────────────┘
       the agent owns ZERO loop logic — it owns the wiring
```

---

## Elaborate

This is composition over inheritance, plus the *assembly root* idea from
DI: there's one place that knows the concrete parts (the caller
constructing the agent), and everything below it speaks ports. The agent
is the seam between "what this capability is" (a model + one tool + a
profile + a policy) and "how any capability runs" (the generic loop).

`context.md` names the shape directly: *"Capability = prompt package +
tool policy + agent loop config + validator,"* and the RAG agent is the
6th instance. That's the recognition test passing — six capabilities, one
loop, each a composition. The reason it earns a file over a lens note:
the *load-bearing test* is concrete — strip the composition and you get
either six forked loops or a vendor-named monolith, both of which the
whole monorepo exists to avoid.

You've built this assembly shape before in the analytics agents
(recommendation, monitoring, diagnostic) — they all compose 
`runAgentLoop` with different policies and prompts. `rag-query` swapping
in the Gemma port and the retrieval tool, with no new framework, is the
clearest demonstration that the composition holds.

Read next: `01-deep-provider-port.md` (the ports composed here),
`04-guard-rails-as-information-hiding.md` (the policy/floor decisions the
agent leans on).

---

## Interview defense

**Q: Why is each agent a composition rather than a subclass of some
`BaseAgent`?** Because the variation between agents is *data* (which tool,
which prompt, which policy, which budget), not *behavior*. Inheritance is
for varying behavior; composition is for varying parts. A `BaseAgent`
hierarchy would force shared behavior into a parent and fork it per
subclass; composing ports into one generic loop keeps the behavior in one
place and lets the parts vary as injected config. Six agents, one loop,
zero subclasses.

```
  inheritance (varies behavior)     composition (varies parts)
  BaseAgent                          runAgentLoop (one loop)
   ├─ RagAgent  (override)            ◄── { model, tools, policy } RAG
   ├─ QueryAgent(override)            ◄── { model, tools, policy } Query
   └─ ... fork the loop per agent     ◄── { ... } — just new config
```

Anchor: "the agents vary in their parts, not their control flow — so compose."

**Q: What proves the agent abstraction is right and not premature?** The
cost of the sixth agent. `rag-query` is a new capability built by
injecting the Gemma port and the `search_knowledge_base` tool into the
existing loop with a new policy and prompt — no new base class, no forked
loop, no framework change. When the next instance costs a config object
instead of new machinery, the abstraction earned its place.

Anchor: "measure an abstraction by the cost of the next instance."

---

## See also

- `01-deep-provider-port.md` — the ports this agent composes
- `04-guard-rails-as-information-hiding.md` — the policy + minTopK it relies on
- `03-contract-as-the-product.md` — the retrieval contract behind the tool
- `00-overview.md` — DI / composition in the PATTERN VOCABULARY
- `audit.md` — lens 4 (layers earn their place), lens 6 (the loop's error handling)
- `../study-agent-architecture/` — the ReAct loop's reasoning mechanics
- `../study-system-design/` — capability boundaries at the service altitude
