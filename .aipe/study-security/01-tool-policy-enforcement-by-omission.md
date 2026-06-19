# Tool-policy enforcement by omission

*Least-privilege capability scoping · LLM-agent security · Project-specific*

## Zoom out, then zoom in

You've built a `fetch()` with `Authorization` headers — the server decides
what that token can reach. Here the question is the same shape but the
"caller" is a language model: of the ~49 tools the registry knows, which
ones is *this* agent allowed to call? The answer lives at one seam, and
it's worth knowing exactly where — because the enforcement is more fragile
than it looks.

```
  Zoom out — where tool-policy sits in the agent stack

  ┌─ Capability layer (per-agent) ──────────────────────────────┐
  │  QueryAgent / RubricImprovementAgent / ...                  │
  │     declares  ★ ToolPolicy (allowlist) ★  ← we are here     │
  └───────────────────────────┬──────────────────────────────────┘
                              │  filterToolsForPolicy(allTools, policy)
  ┌─ Runtime layer ──────────▼──────────────────────────────────┐
  │  runAgentLoop — sends ONLY the filtered schemas to the model │
  │                 calls tools.callTool(name) on tool_use       │
  └───────────────────────────┬──────────────────────────────────┘
                              │  callTool(name, args)
  ┌─ Tools layer ────────────▼──────────────────────────────────┐
  │  InMemoryToolRegistry — holds ALL handlers, runs by name     │
  └───────────────────────────────────────────────────────────────┘
```

The pattern: **the model can only call a tool if it was shown that tool's
schema, and it's only shown the schemas on its allowlist.** Privilege is
granted by what you *don't* hand over. That's enforcement by omission.

## Structure pass

**Layers** (top to bottom): capability declares the policy → runtime filters
and sends schemas → registry executes by name.

**Axis — trust:** *what can the model reach?* Trace it down the layers:

```
  One question down the layers: "what tools can the model reach?"

  capability:  declares allowlist          → INTENT (a list of names)
  runtime:     sends filtered schemas only  → the model SEES only those
  registry:    callTool(name) runs any reg. → it would RUN anything named
```

**Seam — the load-bearing one is between runtime and registry.** The trust
answer *flips* there: above the seam the model is constrained to its
allowlist (it never saw the rest); below the seam the registry will run any
*registered* handler by name. The contract "the model only calls allowed
tools" is enforced entirely *above* this seam, by omission. Nothing *at* the
seam re-checks it. That's the whole lesson of this file.

## How it works

### Move 1 — the mental model

Think of it like rendering a `<select>` with only the options a user's role
should pick. The user can't choose an option that isn't in the DOM. Same
move: the model can't emit a `tool_use` for a tool whose schema it never
received. You shrink the menu instead of validating the order.

```
  The shape — filter the menu, don't check the order

  all tools (49)         policy.allowedTools          model sees
  ┌───────────────┐      ┌──────────────────┐         ┌──────────┐
  │ list_trends   │      │ list_trends      │         │ schema 1 │
  │ get_funnel    │ ───► │ get_funnel       │ ──────► │ schema 2 │
  │ save_judgment │      │ (NOT listed for  │         │   ...    │
  │ delete_report │      │  query-agent)    │         └──────────┘
  │ ... (45 more) │      └──────────────────┘    model can only emit a
  └───────────────┘       Set.has(name) filter   tool_use for what it saw
```

### Move 2 — the walkthrough

**The allowlist is a plain list of names.** Each capability exports a
`ToolPolicy`: a `capabilityId` and a `readonly string[]` of tool names. The
query agent's list is 36 read-only `list_*`/`get_*`/`execute_*` tools. It's
data, not code — you can read the entire grant in one screen.

```
  ToolPolicy = { capabilityId, allowedTools: readonly string[] }
       │
       └─ this list IS the privilege grant — auditable by eye
```

**The filter is a Set membership test.** `filterToolsForPolicy` builds a
`Set` from the allowlist and keeps only the registry tools whose name is in
it, mapping each to the provider-neutral `{name, description, inputSchema}`
schema. One pass, no I/O.

```
  pseudocode — filterToolsForPolicy(allTools, policy)

  allowed = Set(policy.allowedTools)            // O(1) lookups
  for each tool in allTools:
    if allowed.has(tool.name):                  // in the grant?
      yield { name, description, inputSchema }   // schema the model will see
  // tools NOT in the set are simply never produced  ← the omission
```

**The runtime sends only those schemas.** `runAgentLoop` passes the filtered
array as `tools` on every model request. The model literally cannot reference
a tool it wasn't given — there's no name for it to invent that the registry
would then run *as part of this loop*, because the model only knows the names
it saw.

**Here's the part everyone trips on — the execution seam.** When the model
emits a `tool_use`, the loop calls `tools.callTool(toolUse.name, ...)`. The
registry looks the name up in its handler map and runs it if found. It does
**not** re-consult the policy. The registry holds *all* handlers. So the
allowlist is enforced *once*, at the schema-filtering step — and *not again*
at execution.

```
  Layers-and-hops — where enforcement is, and isn't

  ┌─ runtime ─────────┐  hop 1: send filtered schemas   ┌─ model ────┐
  │ runAgentLoop      │ ──────────────────────────────► │ picks tool │
  │                   │  hop 2: tool_use{name} ◄──────── │ from menu  │
  │ callTool(name) ───┼──┐                               └────────────┘
  └───────────────────┘  │ hop 3: lookup name
                         ▼  (NO policy re-check here)
                  ┌─ registry ──────────────────┐
                  │ handlers.get(name) → run     │  ← would run ANY
                  │ throws only if "not found"   │     registered tool
                  └──────────────────────────────┘
```

### Move 2 variant — the load-bearing skeleton

Strip it to the kernel and name each part by what breaks without it:

- **The allowlist (data).** Remove it and there's no grant to filter against
  — every capability would see every tool. This is the policy.
- **The filter (mechanism).** Remove it and the runtime sends the full
  catalog to the model; least-privilege is gone and the model can call
  `save_judgment` from the query agent. This is the enforcement.
- **The Set membership test.** The actual gate. Swap it for a substring match
  and `get_report` would also match a hypothetical `get_report_admin`.

What's **optional hardening that isn't here:** a *second* check inside
`callTool` that the name is in the active policy. Its absence is why the
control is "by omission" rather than "defense in depth." Add it and a model
that somehow named an off-policy tool (prompt injection that guesses a name,
a future bug that leaks schemas) would still be denied at execution.

### Move 3 — the principle

Least-privilege has two enforcement styles: *constrain what the principal can
see* (omission) and *check every action against policy* (mediation). AptKit
does the first cleanly and skips the second. For a local dev-tool that's a
reasonable call — the cheap control catches the realistic case. The principle
to carry: **enforcement by omission is real security but single-layer; if the
omission ever leaks, there's nothing behind it.**

## Primary diagram

The full control, one frame:

```
  Tool-policy enforcement — capability to execution

  ┌─ Capability ─────────────────────────────────────────────┐
  │  ToolPolicy.allowedTools = [list_trends, get_funnel, ...] │
  └───────────────────────────┬───────────────────────────────┘
                              │ filterToolsForPolicy
                              ▼
  ┌─ Runtime ────────────────────────────────────────────────┐
  │  toolSchemas = filtered    ──► model.complete({tools})    │
  │  model emits tool_use{name} ◄──                           │
  │  tools.callTool(name)  ── ENFORCEMENT ENDS HERE ──┐       │
  └───────────────────────────────────────────────────┼───────┘
                                                       ▼
  ┌─ Tools registry ─────────────────────────────────────────┐
  │  handlers.get(name) → run | throw "tool not found"        │
  │  (checks registration, NOT policy)                        │
  └───────────────────────────────────────────────────────────┘
```

## Implementation in codebase

**Use cases.** Every agent reaches for this on every run. The query agent
gets 36 read-only analytics tools and nothing that writes. The
recommendation/monitoring/diagnostic agents get their own read-only subsets.
`rubric-improvement` is the one capability granted a write tool
(`save_judgment`) — the widest grant in the repo, and the only one that can
change state.

**The policy and the filter, side by side:**

```
  packages/tools/src/tool-policy.ts  (lines 5-23)

  export type ToolPolicy = {
    capabilityId: string;
    allowedTools: readonly string[];   ← the grant, as plain data
  };

  export function filterToolsForPolicy(allTools, policy): ModelTool[] {
    const allowed = new Set(policy.allowedTools);   ← O(1) membership
    return allTools
      .filter((tool) => allowed.has(tool.name))     ← keep only granted
      .map((tool) => ({ name, description, inputSchema }));
        │                                             ← provider-neutral
        └─ tools not in the set are never produced — the omission IS the gate
  }
```

**The widest grant — `rubric-improvement`:**

```
  packages/agents/rubric-improvement/src/rubric-improvement-agent.ts (15-25)

  export const rubricImprovementToolPolicy = {
    capabilityId: RUBRIC_IMPROVEMENT_CAPABILITY_ID,
    allowedTools: [
      'get_recent_judgments', 'get_user_pattern_history',
      'get_rubric_definition', 'get_current_attempt_context',
      'save_judgment',          ← the ONLY mutating tool in any policy
      'generate_next_scenario',
    ] as const,
  };
        │
        └─ every other agent is read-only; this one can write a judgment.
           That's the task, so the grant is justified — but it's the one
           capability to watch.
```

**The seam where enforcement ends:**

```
  packages/runtime/src/run-agent-loop.ts  (line 159)

  const { result, durationMs } =
    await tools.callTool(toolUse.name, toolUse.input, { signal });
        │
        └─ whatever name the model emitted goes straight to the registry.
           No policy re-check.

  packages/tools/src/tool-registry.ts  (lines 56-59)

  const handler = this.handlers.get(name);
  if (!handler) {
    throw new Error(`tool not found: ${name}`);   ← checks REGISTRATION,
  }                                                  not POLICY
        │
        └─ registry holds ALL handlers; without a policy arg here, a name
           that reached this line outside the allowlist would execute.
```

## Elaborate

This is the classic split between *policy* (the allowlist) and *mechanism*
(the filter + registry). AptKit keeps policy as declarative data next to each
agent, which is the right instinct — you can audit every capability's reach
by reading one `const`. The single-layer enforcement is a deliberate
simplicity tradeoff for a dev-tool. In a hosted, multi-tenant version the
move is to pass the active `ToolPolicy` into the `ToolExecutor` and re-check
membership inside `callTool`, turning omission into mediated access control.
See `.aipe/study-system-design/04-capability-as-tool-policy.md` for the same
mechanism viewed as architecture, and `.aipe/study-agent-architecture/` for
read-only grants framed as an agent-*safety* property.

## Interview defense

**Q: How does AptKit stop an agent from calling a tool it shouldn't?**

> It filters the tool *menu* before the model ever sees it. Each capability
> declares a `ToolPolicy` allowlist; `filterToolsForPolicy` does a `Set`
> membership filter so the model only receives schemas for tools on the list.
> The model can't emit a `tool_use` for a tool it never saw — enforcement by
> omission.

```
  all tools ──filter(Set.has)──► granted schemas ──► model sees only these
```

**Anchor:** the model can't order off a menu you didn't print.

**Q: What's the weakness in that?**

> It's single-layer. At execution, `run-agent-loop.ts:159` calls
> `tools.callTool(name)` and the registry (`tool-registry.ts:56`) only checks
> the tool is *registered*, not that it's in the policy — and the registry
> holds every handler. So if a name ever reached `callTool` off-policy, it'd
> run. The fix is to pass the policy into the executor and re-check there.

**Anchor:** the bouncer checks the guest list at the door, but there's no
second check at the bar.

## Validate

1. **Reconstruct:** from memory, draw the path from `ToolPolicy.allowedTools`
   to `model.complete({tools})` and name where enforcement stops.
2. **Explain:** why is `filterToolsForPolicy` (`tool-policy.ts:11`) a `Set`
   test and not a substring match? (Substring would over-grant on prefixes.)
3. **Apply:** the query agent (`query-agent.ts:10`) is handed a registry that
   also contains `save_judgment`. Can it call it? Why not — and what single
   line would have to change for the answer to flip?
4. **Defend:** argue whether re-checking the policy in
   `tool-registry.ts:callTool` is worth the coupling for a local dev-tool, vs
   for a hosted Studio.

## See also

- `audit.md` → lens 7 (LLM/agent security)
- `04-validated-model-output-gate.md` — the output-side companion control
- `.aipe/study-system-design/04-capability-as-tool-policy.md`
- `.aipe/study-agent-architecture/` — read-only grants as safety
