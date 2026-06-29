# Tool Routing
*Tool routing · capability scoping (Industry standard)*

The naive picture of tool routing is "give the model all the tools and let it pick." aptkit does the opposite, and it's the right call: routing here is **deterministic and least-privilege**. Before the model sees anything, two filters run. The tool-policy allowlist (`filterToolsForPolicy`) scopes a capability to *only* the tools its role permits — the RAG query agent literally cannot see anything but `search_knowledge_base`. And the coverage gate (`runnableRequirements`) drops work the system *can't* do before spending a single token on it. Heuristics up front, model at the back, working over a pre-narrowed menu.

The model still routes — within the loop it picks which of its allowed tools to call. But the *set it picks from* is decided by code, not by the model. That's the distinction that matters: capability scoping is a deterministic gate, tool selection is the model's job, and they're stacked in that order.

## Zoom out, then zoom in

Two deterministic filters sit between the request and the model. The model only routes inside what survives them.

```
Routing stack — heuristics front, model back
┌──────────────────────────────────────────────────────────────────────┐
│  all registered tools  (the full catalog)                             │
│        │                                                              │
│        ▼  FILTER 1 — coverage gate (runnableRequirements)             │
│   drop work whose required capabilities aren't available    ★ pre-LLM │
│        │                                                              │
│        ▼  FILTER 2 — tool policy (filterToolsForPolicy)               │
│   keep only allowedTools ∩ available  → ModelTool[]         ★ pre-LLM │
│        │                                                              │
│        ▼                                                              │
│   model picks WHICH of the surviving tools to call          ← the LLM │
└──────────────────────────────────────────────────────────────────────┘
```

Both ★ filters run *before* the model is invoked. That's the design opinion: you don't pay model tokens to discover you can't do something, and you don't risk the model reaching for a tool its role shouldn't touch. The model's freedom is real but fenced.

## Structure pass

Trace **control** — who decides which tool runs — and watch it hand off.

Control starts entirely with code. The coverage gate looks at which capabilities are wired and filters the requirement list: `requirementCoverage(requirement, capabilities) !== 'unavailable'` (`coverage-gate.ts:77`). Work that can't run never reaches the model. Then the policy filter intersects the capability's allowlist with what's registered: `allowed.has(tool.name)` (`tool-policy.ts:16-17`). Now the model gets a `ModelTool[]` that's a strict subset of the catalog.

The seam where control flips to the model is `runAgentLoop` — once `toolSchemas` is built, the model picks freely among *those* on each turn. But it can never widen the set. If a query needs a tool the policy didn't grant, the model can't call it; it'll either work around it or say it can't. Control: code narrows, model selects, code never re-widens.

## How it works

### Move 1 — the mental model

Routing is set-arithmetic done by code, then a choice made by the model. The arithmetic is `allowedTools ∩ availableTools`. The choice is whatever the model does inside the loop.

```
The kernel: narrow by intersection, then let the model choose
  visible = policy.allowedTools  ∩  registry.tools     (code, deterministic)
  chosen  = model picks from visible, per turn          (LLM, dynamic)
```

### Move 2 — the moving parts

**The tool policy — the least-privilege allowlist.** Each capability declares the tools its role may use. The filter reduces the registry to that intersection and maps it to provider-neutral schemas.

```
ToolPolicy { capabilityId, allowedTools[] }   ──intersect──►  ModelTool[]
   registry catalog ──┘                                       (what the model sees)
```

```ts
// packages/tools/src/tool-policy.ts:5-23
export type ToolPolicy = {
  capabilityId: string;
  allowedTools: readonly string[];   // ◄── the role's grant, declared in code
};

export function filterToolsForPolicy(allTools, policy): ModelTool[] {
  const allowed = new Set(policy.allowedTools);
  return allTools
    .filter((tool) => allowed.has(tool.name))   // ◄── intersection: allowed ∩ available
    .map((tool) => ({ name: tool.name, description: tool.description ?? '', inputSchema: tool.inputSchema }));
}
```

The RAG query agent's policy is the cleanest example — one tool, full stop:

```ts
// packages/agents/rag-query/src/rag-query-agent.ts:15-18
export const ragQueryToolPolicy: ToolPolicy = {
  capabilityId: RAG_QUERY_CAPABILITY_ID,
  allowedTools: [SEARCH_KNOWLEDGE_BASE_TOOL_NAME],   // ◄── this agent sees nothing else
};
```

The five analytics agents scale this same shape up: recommendation grants 13 tools, query grants ~40 read-only tools, anomaly-monitoring grants 4. Same mechanism, different blast radius — and all read-only.

**The coverage gate — drop unavailable work pre-model.** This is the cheaper filter, and it runs first conceptually: if the capabilities backing a task aren't present, the task is removed before the model is asked to attempt it.

```ts
// packages/tools/src/coverage-gate.ts:72-78
/** Filters out tasks that cannot run before the agent spends model tokens on them. */
export function runnableRequirements<T extends CoverageRequirement>(
  requirements: readonly T[],
  capabilities: ReadonlySet<string>,
): T[] {
  return requirements.filter(
    (requirement) => requirementCoverage(requirement, capabilities) !== 'unavailable',  // ◄── drop pre-LLM
  );
}
```

### Move 3 — the principle

Default to deterministic routing with least privilege. Let code decide *what a role is allowed to touch* and *what's even possible*, and let the model decide only *which allowed tool to use right now*. This keeps the model's wandering bounded to a safe, role-appropriate set and saves tokens on impossible work. The model is a router, but only within the lane code drew.

## Primary diagram

```
Tool routing for the rag-query agent
┌─────────────────────────────────────────────────────────────────────────┐
│ registry catalog: [search_kb, write_*, delete_*, ...40+ tools]            │
│        │                                                                  │
│        ▼ runnableRequirements(capabilities)   ── pre-LLM, drop impossible │
│ runnable tasks only                                                       │
│        │                                                                  │
│        ▼ filterToolsForPolicy(allTools, ragQueryToolPolicy)               │
│ visible to model: [ search_knowledge_base ]   ◄── least privilege, n=1    │
│        │                                                                  │
│        ▼ runAgentLoop                                                      │
│ model routes among the visible set, per turn  ◄── dynamic, but fenced     │
└─────────────────────────────────────────────────────────────────────────┘
```

## Elaborate

aptkit's routing is *all* heuristic-front today — there's no LLM-based router that reads a query and picks which capability to invoke. The capability is chosen by the caller (you call `RagQueryAgent` or the recommendation agent), and within it the allowlist + gate are pure code. The model's only routing role is intra-loop tool selection. That's a deliberate safety posture for read-only analytics, but it means an *ambiguous* query ("is this a recommendation question or a diagnostic one?") has no automatic disambiguation — the caller must know. That gap is exactly what the exercise below probes.

## Project exercises

### Add an LLM-routed fallback for ambiguous queries

- **Exercise ID:** `EX-ROUTE-04a`
- **What to build:** A thin routing step that, when a query doesn't clearly map to one capability, asks the model to classify it into one of the known capability IDs (recommendation / diagnostic / query / rag-query), then dispatches to that agent. Heuristic-first: only invoke the LLM router when a cheap rule can't decide. This extends Phase 4's deterministic routing with the LLM-back tier.
- **Why it earns its place:** Shows the canonical production pattern — cheap deterministic routing for the obvious cases, LLM routing only for the ambiguous tail — and forces you to keep the allowlist/least-privilege guarantees intact across the dispatch.
- **Files to touch:** A new router module under `packages/agents/` (or a wrapper), referencing the existing `*_CAPABILITY_ID` constants in each agent; reuse `filterToolsForPolicy` from `packages/tools/src/tool-policy.ts`.
- **Done when:** An unambiguous query routes deterministically with zero extra model calls, an ambiguous one routes via a single classification call, and each routed agent still only sees its own allowlist.
- **Estimated effort:** `1–2 days`

## Interview defense

**Q: Do you give the model all your tools and let it choose?**

```
NO. code narrows: allowedTools ∩ available → model picks within that
```

A: No — that's an over-grant. Each capability has a `ToolPolicy` allowlist, and `filterToolsForPolicy` hands the model only the intersection of its role's tools and what's registered. The RAG agent sees exactly one tool. The model routes *within* that set per turn but can never widen it. Anchor: `tool-policy.ts:16` — `allowed.has(tool.name)`.

**Q: Why filter before the model instead of letting it fail on a missing tool?**

```
runnableRequirements drops impossible work → no tokens wasted
```

A: Two reasons — cost and safety. The coverage gate drops work whose capabilities aren't wired *before* any model call, so I don't pay tokens to discover impossibility. And the allowlist means a role can't reach a tool it shouldn't, which is the least-privilege guarantee. Anchor: `coverage-gate.ts:77` — drop when `'unavailable'`.

## See also

- [02-tool-calling.md](02-tool-calling.md) — the `ModelTool[]` this filter produces is what the provider renders.
- [01-agents-vs-chains.md](01-agents-vs-chains.md) — where `filterToolsForPolicy` is called in `answer()`.
- [06-error-recovery.md](06-error-recovery.md) — what happens when the model wants a tool it wasn't granted.
