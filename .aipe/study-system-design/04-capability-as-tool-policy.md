# Capability as tool policy — per-agent least privilege

**Industry names:** Capability-based security / least-privilege allowlist / scoped tool access. **Type:** Industry standard (the per-agent allowlist binding is project-specific).

## Zoom out, then zoom in

This lives in the policy band between the agents and the runtime loop. Find the box that sits *between* an agent and the full tool catalog — it's what decides which tools that agent is even allowed to see.

```
  Zoom out — where tool policy lives

  ┌─ Capability layer — packages/agents/* ──────────────────┐
  │  each agent declares a toolPolicy (capabilityId +       │
  │  allowedTools[])                                         │
  └───────────────────────────┬──────────────────────────────┘
                              │  filterToolsForPolicy(allTools, policy)
  ┌─ Policy layer — packages/tools ───────────▼──────────────┐
  │  ★ ToolPolicy + filterToolsForPolicy ★  ← allowlist gate │ ← we are here
  │  ToolRegistry (the full ~49-tool catalog)                │
  └───────────────────────────┬──────────────────────────────┘
                              │  only the allowed ModelTool[] schemas
  ┌─ Runtime core ────────────▼──────────────────────────────┐
  │  runAgentLoop gets ONLY the filtered tool schemas         │
  └──────────────────────────────────────────────────────────┘
```

Now zoom in. You've done this in a frontend: a component gets passed only the props it needs, not the whole store — so it physically *can't* touch state outside its scope. Tool policy is that, for an agent's tool access. The pattern is **capability-based least privilege**: each agent declares an allowlist of tool names, and the loop only ever sees the tools on that list. An agent that isn't allowed to call `save_judgment` doesn't get told `save_judgment` exists — it's not in scope, so the model can't request it.

## Structure pass

**Layers:** the full registry (all tools) → the per-agent policy (a name allowlist) → the filtered schemas (what the loop sees). One axis cuts through.

**Axis — trust: what can each side see?**

```
  "what tools can this side see?" — traced through the filter

  ┌─ ToolRegistry ──────────┐  filter  ┌─ one agent's loop ───┐
  │ ALL ~49 tools           │ ═══╪════► │ ONLY its allowlist   │
  │ (the whole catalog)     │ (it flips)│ (e.g. 6 tools)       │
  └─────────────────────────┘           └──────────────────────┘
         ▲                                      ▲
         └─ everything is visible ──── nothing outside the list is ─┘
            → the filter is the trust boundary: visibility shrinks here
```

The visibility answer flips across the filter — the registry sees everything, the agent sees a subset. *That flip is the security seam.* The agent literally cannot name a tool it wasn't granted, because the schema for it never reaches the model. The seam to study: `filterToolsForPolicy`. Hand off to How it works.

## How it works

#### Move 1 — the mental model

The shape is a Set-membership filter — build a Set from the allowlist, keep only the catalog entries whose name is in it. You've written this exact thing filtering a list against a set of allowed ids. The kernel is three lines: make the Set, filter by `name`, project to schemas.

```
  The allowlist filter — Set membership, by name

  allowed = Set(policy.allowedTools)        // e.g. {"get_segments", ...}

  filtered = allTools
     .filter(t => allowed.has(t.name))      // keep only granted names
     .map(t => ({ name, description, inputSchema }))   // → ModelTool schema

  ┌── catalog ──┐   ┌─ allowed set ─┐   ┌── filtered ──┐
  │ ~49 tools   │ + │ 6 names       │ = │ exactly 6    │
  └─────────────┘   └───────────────┘   └──────────────┘
```

That's the whole mechanism. The interesting part isn't the filter — it's *where the filtered set goes* and what the agent can do with what's left out (nothing).

#### Move 2 — the step-by-step walkthrough

**The policy is a name allowlist bound to a capability.** Each agent exports a `ToolPolicy`: `{ capabilityId, allowedTools }` where `allowedTools` is a readonly array of tool-name strings. The bridge: it's a role's permission list, but the "role" is the capability (`anomaly-monitoring-agent`, `recommendation-agent`). The binding to `capabilityId` is what ties a permission set to a specific agent.

```
  one policy
  { capabilityId: 'anomaly-monitoring-agent',
    allowedTools: ['execute_analytics_eql', 'get_metric_timeseries',
                   'get_segments', 'get_anomaly_context'] }   ← exactly 4 tools
```

**The filter projects the catalog down to the grant.** `filterToolsForPolicy(allTools, policy)` builds a `Set` from `allowedTools` (O(1) membership) and keeps only catalog tools whose `.name` is in the set, mapping each to a `ModelTool` schema (name, description, inputSchema). The bridge: this is `array.filter(t => allowedSet.has(t.name))` — the thing you reach for daily. The boundary condition: matching is *exact string* on name, no patterns, no wildcards. Add a tool to the catalog and it's invisible to every agent until you explicitly add its name to a policy. That's the safe default — opt-in, not opt-out.

```
  Layers-and-hops — the filtered tools reaching the loop

  ┌─ agent (capability) ─┐ hop 1: filterToolsForPolicy(allTools, myPolicy)
  │ declares toolPolicy  │ ───────────────────────────────────────────────►┐
  └──────────────────────┘                                                  │
  ┌─ tools (policy) ─────┐ hop 2: Set(allowedTools); filter catalog by name ▼
  │ filterToolsForPolicy │ ──────────────────────────────► ModelTool[] (subset)
  └──────────────────────┘                                          │
  ┌─ runtime (loop) ─────┐ hop 3: runAgentLoop({ toolSchemas })     ▼
  │ model only SEES the  │ ◄──────────────────────────────────────────────
  │ granted tool schemas │   → model can't request what it can't see
  └──────────────────────┘
```

**The registry executes, the policy gates.** The `ToolRegistry` is a `Map<name, handler>` — `callTool(name, args)` does an O(1) lookup and runs the handler (measuring duration, checking the abort signal). The split is the point: the *registry* knows how to run every tool; the *policy* decides which ones an agent was offered. The bridge: it's the difference between a route handler existing (registry) and a user's role being allowed to hit it (policy). The boundary condition: the registry doesn't enforce the policy — enforcement happens by *omission*, upstream, by never putting the schema in front of the model. The model can only request tools it was shown.

**The agents are read-only.** Every agent's `allowedTools` is a list of `list_*` / `get_*` / `execute_analytics_*` reads (`context.md`: "per-agent read-only allowlists"). The one near-exception, `rubric-improvement`, includes `save_judgment` and `generate_next_scenario` — which is exactly why its blast radius (and the missing replay coverage, audit red-flag 4) matters more. The newest agent, `rag-query`, is the tightest case of all: its policy grants exactly one tool, `search_knowledge_base` (`packages/agents/rag-query/src/rag-query-agent.ts:15-18`) — the same least-privilege mechanism taken to its minimum. The read-only default means a misbehaving model can read the workspace but can't mutate it.

#### Move 2 variant — the load-bearing skeleton

1. **Isolate the kernel.** A per-capability allowlist of tool names + a Set-membership filter that projects the full catalog down to the granted subset + the rule that the loop only receives the filtered subset.

2. **Name each part by what breaks if removed.**
   - Remove the **per-agent allowlist** → every agent sees all ~49 tools, so a query agent could call a mutation tool, and a monitoring agent could call tools meant for diagnosis. Least privilege is gone; the blast radius is the whole catalog.
   - Remove the **filter at the seam** (hand the loop the full catalog directly) → the policy becomes documentation, not enforcement. The model is shown everything and will use it.
   - Remove the **"loop only sees the subset" rule** (e.g. filter for display but pass full tools to the model) → the policy is cosmetic; enforcement-by-omission collapses.

3. **Skeleton vs hardening.** Skeleton: the allowlist + the filter + the omission. Hardening: the `capabilityId` binding (provenance/tracing), the read-only convention, the `ToolCallOptions` abort signal in the registry. The capability *works* with just the skeleton; the hardening makes it auditable.

The interview payoff: name **enforcement-by-omission**. The naive instinct is to check the policy *when a tool is called* ("is this agent allowed to call `X`?"). AptKit does it earlier and stronger: the model is never *shown* the tools it can't use, so it can't request them in the first place. You don't reject a forbidden call — you make the forbidden call un-formulable. That's a stronger guarantee, and it's the part that signals you understand capability security vs access-control checks.

#### Move 3 — the principle

Don't check permissions at the call — remove the capability from view. The strongest form of least privilege isn't "deny the request you weren't allowed to make"; it's "never present the option, so the request can't be formed." Shrinking what's *visible* to a component is more robust than guarding what it *does*, because there's no check to forget and no path to bypass.

## Primary diagram

The full recap — catalog, per-agent policies, the filter, and the loop receiving only its grant.

```
  Capability as tool policy — full picture

  ┌─ tools: ToolRegistry (Map<name, handler>) ───────────────────────┐
  │  ~49 tools: list_*, get_*, execute_analytics_*, save_*, ...       │
  └──────────────────────────────┬────────────────────────────────────┘
                                 │  filterToolsForPolicy(allTools, policy)
        ┌────────────────────────┼────────────────────────┐
        ▼                        ▼                        ▼
  ┌───────────────┐      ┌───────────────┐        ┌──────────────────┐
  │ monitoring    │      │ recommendation│        │ rubric-improvement│
  │ policy: 4     │      │ policy: 13    │        │ policy: 6         │
  │ read-only     │      │ read-only     │        │ incl. save_*      │ ◄─ wider grant
  └──────┬────────┘      └──────┬────────┘        └────────┬─────────┘
         │ filtered subset      │ filtered subset           │
         ▼                      ▼                           ▼
  ┌──────────────────────────────────────────────────────────────────┐
  │  runAgentLoop({ toolSchemas: ONLY this agent's granted tools })    │
  │  → the model is shown only the subset → can't request the rest     │
  └──────────────────────────────────────────────────────────────────┘
```

## Implementation in codebase

**Use cases.** When the monitoring agent runs, it can scan metrics (`get_metric_timeseries`, `get_segments`) but cannot touch email campaigns or experiments — those tools simply aren't in its prompt. When the recommendation agent runs, it gets a wider grant (13 tools, including scenario and initiative reads) because proposing actions needs more context. The query agent gets the widest grant (~35 read tools) because it answers arbitrary NL questions. The grant *is* the capability's surface area — declared once per agent, enforced by the filter.

**The policy + filter** — `packages/tools/src/tool-policy.ts` (lines 5–23):

```
  export type ToolPolicy = {                          ← lines 5-8
    capabilityId: string;       ← binds the grant to ONE agent
    allowedTools: readonly string[];   ← the allowlist, by tool NAME
  };

  export function filterToolsForPolicy(allTools, policy): ModelTool[] {  ← line 11
    const allowed = new Set(policy.allowedTools);     ← line 15, O(1) membership
    return allTools
      .filter((tool) => allowed.has(tool.name))       ← line 17, the gate (exact name)
      .map((tool) => ({ name: tool.name,
        description: tool.description ?? '',
        inputSchema: tool.inputSchema }));            ← lines 18-22, project to schema
  }
       │
       └─ Line 17 IS the trust boundary. Exact string match on name — no wildcards.
          A new catalog tool is invisible until its name is added to a policy
          (opt-in default). The filtered result is what the loop hands the model.
```

**A real policy** — `packages/agents/anomaly-monitoring/src/monitoring-agent.ts` (lines 11–20):

```
  export const anomalyMonitoringToolPolicy = {        ← line 11
    capabilityId: ANOMALY_MONITORING_CAPABILITY_ID,   ← bound to this agent
    allowedTools: [
      'execute_analytics_eql',
      'get_metric_timeseries',
      'get_segments',
      'get_anomaly_context',                          ← exactly 4, all read-only
    ] as const,
  };
       │
       └─ Four tools. The monitoring agent CANNOT see list_email_campaigns or
          list_experiments (those are in the diagnostic agent's grant). Compare to
          recommendation's 13-tool grant — the grant size IS the capability's reach.
```

**The registry that executes** — `packages/tools/src/tool-registry.ts` (lines 16–64):

```
  export type ToolRegistry = {                        ← lines 16-24
    listTools(): ToolDefinition[] | Promise<...>;     ← the full catalog
    callTool(name, args, options?): Promise<ToolCallResult>;  ← execute by name
  };

  // InMemoryToolRegistry
  this.handlers = new Map(...);                        ← line 34, Map<name, handler>
  async callTool(name, args, options) {
    options?.signal?.throwIfAborted();                 ← line 55, cancellation
    const handler = this.handlers.get(name);           ← line 56, O(1) lookup
    if (!handler) throw ...;                            ← lines 57-59
    // run handler, measure durationMs, return { result, durationMs }  ← lines 61-63
  }
       │
       └─ The registry runs ANY registered tool — it does NOT enforce the policy.
          Enforcement is upstream and by omission: the policy decided which schemas
          the model ever saw. The registry is the executor; the policy is the gate.
```

## Elaborate

This is capability-based security — a model where access is granted by *holding a capability* (here, having the tool's schema in your prompt) rather than checked against an access-control list at call time. The classic ACL approach asks "is subject S allowed action A on object O?" at every call. The capability approach hands you exactly the references you're allowed to use and nothing else, so there's no check to perform. AptKit's version is a clean fit because LLM tool-use is *prompt-driven*: a model can only call a tool whose schema it was given, so withholding the schema is a hard, un-bypassable grant boundary.

The LLM/agent-security view — prompt injection trying to escalate beyond the granted tools, the read-only convention as a mitigation — belongs to study-security when generated. The data-structure view (Set membership cost, Map lookup) is study-dsa-foundations. Here the lens is purely architectural: the policy is a trust seam, and its load-bearing property is that it shrinks *visibility*, not just *permission*.

Next: `05-multi-agent-pipeline.md` shows three agents with three different grants composing — and why each stage's narrow grant matters when they're chained.

## Interview defense

**Q: How do you stop an agent from using tools it shouldn't?**

Per-capability allowlists enforced by omission. Each agent declares `allowedTools` (tool names); a filter projects the full catalog down to that subset; the loop hands the model *only* the subset. The model can't request a tool whose schema it never saw.

```
  catalog (49) ─filter by name─► agent's grant (e.g. 4) ─► model sees only these
                                                            → forbidden tools un-callable
```

Anchor: `tool-policy.ts:11-23` (the filter), `monitoring-agent.ts:11-20` (a 4-tool grant).

**Q: Why filter the tools instead of checking permission when a tool is called?**

Because withholding is stronger than denying. If you check at call-time, you have to get every check right and the model still "knows" the tool exists and may keep trying. If you never show the schema, the call can't be formulated — there's no check to bypass and nothing to forget.

```
  call-time check:  model requests forbidden tool → you reject  (model still tries ✗)
  omission:         model never sees the schema → can't request it  ✓
```

Anchor: `tool-policy.ts:17` (filter happens before the loop), `tool-registry.ts:50-64` (registry executes but doesn't gate).

## Validate

1. **Reconstruct.** Write `filterToolsForPolicy` from memory — the Set, the filter-by-name, the projection. Check against `tool-policy.ts:11-23`.
2. **Explain.** Where is the policy *enforced* — in the registry's `callTool`, or before the loop? Why does that distinction matter? (Hint: `tool-registry.ts:56` does no policy check.)
3. **Apply.** You add a new `delete_segment` tool to the catalog. Which agents can now call it, and what's the minimum change to grant it to exactly one agent? (Answer: none can, until you add `'delete_segment'` to one policy's `allowedTools`.)
4. **Defend.** The `rubric-improvement` agent has `save_judgment` in its grant (`rubric-improvement-agent.ts:15-25`) and no `replay:promoted` coverage (audit red-flag 4). Argue why that combination is the one to worry about.

## See also

- `02-bounded-agent-loop.md` — the loop that receives the filtered `toolSchemas`.
- `05-multi-agent-pipeline.md` — three agents with three grants, composed.
- `audit.md` lens 1 (the policy as a trust boundary), red-flag 4 (rubric-improvement's wider grant).
- study-security (when generated) — prompt-injection and the read-only convention.
