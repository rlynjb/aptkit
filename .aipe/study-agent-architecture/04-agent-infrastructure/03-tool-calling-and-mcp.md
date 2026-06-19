# 03 — Tool Calling and MCP

*Tool calling / tool registry / MCP — Pattern + in-codebase (tool-calling is
universal; AptKit uses direct tool definitions behind a registry seam, NOT MCP).*

## Zoom out, then zoom in

Tool calling is the connective tissue of every agent: it's how a model that can
only emit text reaches out and touches the world. But "the model calls a tool"
hides four separate decisions — *what tools exist, which ones this agent may
see, who actually runs them, and how the model names them.* AptKit pulls those
apart cleanly, so start by seeing the layers between "model wants data" and "data
comes back."

```
  The layers between a model's intent and a tool result

  ┌─ the model ── emits intent only ──────────────────────────────────┐
  │  "I want get_segments({metric:'revenue'})"   ← a name + args, runs nothing │
  └───────────────────────────────┬────────────────────────────────────┘
                                  ▼
  ┌─ ToolPolicy + filterToolsForPolicy ── what this agent MAY see ─────┐
  │  capabilityId + allowedTools[]  →  intersect with the catalog      │
  │  the model is only OFFERED the tools its role allows               │
  └───────────────────────────────┬────────────────────────────────────┘
                                  ▼
  ┌─ ToolExecutor seam ── who RUNS it (the harness, not the model) ────┐
  │  tools.callTool(name, args, { signal })   ← run-agent-loop.ts:159  │
  └───────────────────────────────┬────────────────────────────────────┘
                                  ▼
  ┌─ ToolRegistry ── the catalog + the handlers ──────────────────────┐
  │  listTools() → defs ;  callTool() → runs handler, records duration │
  └─────────────────────────────────────────────────────────────────────┘
```

The frontend anchor: this is your API layer. `ModelTool` schemas are the
OpenAPI spec (the contract the caller reads). `ToolPolicy` is the auth
middleware deciding which endpoints this client may call. `ToolRegistry` is the
router that dispatches a request to a handler. The model is a client that can
*describe* a request but can't make it — your harness makes it.

## Structure pass

Trace the **authority axis** — *who decides each thing, and where that decision
lives.* This is the seam between "the model's intent" and "your code's control."

```
  The authority axis: who decides what, and where

  Decision                  Owned by              Lives in
  ────────────────────────  ────────────────────  ─────────────────────────────
  which tools exist          the host (registry)   ToolRegistry.listTools()
  which tools this role sees  the policy            filterToolsForPolicy (line 11)
  ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─  ─ ─ ─ ─ ─ ─ ─ ─ ─ ─  ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ◄ SEAM
  WHICH tool to call now      the MODEL              tool_use block it emits
  whether/how it runs         the HARNESS            tools.callTool (line 159)
```

The seam is the line between *configuration* (what's possible, decided by your
code before the run) and *execution* (what happens now, where the model proposes
and the harness disposes). Above the seam you've already constrained the
model — it can only pick from the tools your policy let through. Below it, the
model picks, but your harness runs. The model never crosses the seam downward;
it only emits a request.

## How it works

### Move 1 — the mental model

A tool registry is a **gateway**: one catalog of callable functions, fronted by
a uniform interface, with per-caller scoping in front of it. Every agent reaches
through the *same* registry; what differs per agent is the *policy* that filters
the catalog down to its role.

```
  One registry, many agents, each scoped by policy (PATTERN)

                     ┌──────────────────────────────┐
                     │     ToolRegistry (catalog)    │
                     │  ~35 read-only analytics tools │
                     └───────────────┬────────────────┘
            filterToolsForPolicy(catalog, policy) per agent
       ┌───────────────┬─────────────┴───────────┬───────────────┐
       ▼               ▼                         ▼               ▼
  monitoring       diagnostic               recommendation     query
  sees 4 tools     sees its subset          sees its subset    sees ~35
  (allowlist)      (allowlist)              (allowlist)        (broad)
```

The model behind each agent is *offered* only its slice. That's least-privilege:
even if the model wanted a tool outside its role, it never appears in the schema
list, so it structurally cannot ask for it.

### Move 2 — the pieces, one at a time

**Piece 1 — `ModelTool`: the provider-neutral schema**

```
  a tool definition is a name + description + JSON input schema

  { name: "get_segments",
    description: "...",
    inputSchema: { type:"object", properties:{ metric:{...} } } }
       ▲
   provider-neutral: not an Anthropic shape, not an OpenAI shape — AptKit's own
```

Pseudocode: `type ToolDefinition = ModelTool`. This is the contract the model
reads to know a tool exists and how to call it. It's re-exported from the
runtime so every layer speaks one schema shape; the provider adapter translates
it to whatever the wire format needs.

**Piece 2 — `ToolRegistry`: the gateway interface**

```
  two methods: discover, then dispatch

  listTools()                         → ToolDefinition[]   (the catalog)
  callTool(name, args, { signal })    → { result, durationMs }
       │                                            ▲
       └─ looks up handler by name, runs it, TIMES it (line 61-63)
```

Pseudocode: `interface ToolRegistry { listTools(); callTool(name, args, opts) }`.
`InMemoryToolRegistry` is the test/demo implementation: fixed defs + injected
handlers, and it records wall-clock `durationMs` on every call so the trace can
report tool latency.

**Piece 3 — `ToolPolicy` + `filterToolsForPolicy`: the auth middleware**

```
  intersect the catalog with the role's allowlist

  catalog = [ A, B, C, D, E, ... ]          ← everything the registry has
  policy  = { capabilityId, allowedTools: [A, C] }
       │  filterToolsForPolicy(catalog, policy)
       ▼
  offered = [ A, C ]                         ← all the model ever sees
```

Pseudocode: `offered = catalog.filter(t => policy.allowedTools.has(t.name))`.
The policy is data (a capability id + a list of names), not code. Filtering
happens *before* the loop, so the `toolSchemas` passed to `runAgentLoop` are
already scoped — the model is never even shown the tools it isn't allowed to use.

**Piece 4 — the `ToolExecutor` seam: model proposes, harness disposes**

```
  the model emits intent; the HARNESS executes it

  model: tool_use { name:"get_segments", input:{...} }   ← intent
                          │
                          ▼  the loop, NOT the model, calls:
  tools.callTool("get_segments", {...}, { signal })       ← run-agent-loop.ts:159
                          │
                          ▼
  { result, durationMs } ──▶ pushed back as a tool_result
```

Pseudocode: `for each tool_use: { result } = await tools.callTool(name, args);
push tool_result`. This is the most important seam in any agent: the model
*never* runs anything. It dispatches; your code performs. Every safety property
in this guide lives here — because *you* run the tool, *you* decide which exist
and what they may do.

### Move 3 — the principle

Tool calling is a contract, not a capability grant: the model can only *describe*
a request, and a registry behind a per-role policy decides what's reachable and a
harness decides what actually runs. Keep the catalog uniform, scope per role,
and own the execution seam — that's where control lives.

## Primary diagram

The full tool-calling path for one AptKit agent, configuration through
execution.

```
  Tool calling, configuration → execution (one agent run)

  CONFIGURATION (before the loop):
    allTools    = registry.listTools()                       ← the catalog
    toolSchemas = filterToolsForPolicy(allTools, policy)      ← scope to role
                   policy = { capabilityId, allowedTools[] }   (tool-policy.ts:11)

  EXECUTION (inside runAgentLoop):
    model.complete({ system, messages, tools: toolSchemas })  ← OFFER scoped tools
         │
         ▼  response.content has tool_use blocks?
    for each tool_use { name, input }:
         emit tool_call_start  ────────────────────────────── trace
         { result, durationMs } = tools.callTool(name, input, { signal })  (line 159)
         emit tool_call_end (with durationMs) ──────────────── trace
         push tool_result( truncate(result) ) into messages
         │
         ▼  loop until no tool_use OR budget exit
```

Read it as two phases. The configuration phase (filter the catalog) runs once
and is pure data manipulation. The execution phase (the model picks, the harness
runs) is the loop, and the `callTool` line is the seam everything pivots on.

## Implementation in codebase

**Use case 1 — the registry interface and a timing implementation.**
`packages/tools/src/tool-registry.ts:17` (interface) and `:33` (impl):

```ts
export type ToolRegistry = {                              // line 17
  listTools(): Promise<ToolDefinition[]> | ToolDefinition[];
  callTool(name, args, options?): Promise<ToolCallResult>;
};

export class InMemoryToolRegistry implements ToolRegistry { // line 33
  async callTool(name, args, options?) {
    options?.signal?.throwIfAborted();                     // cancellation honored here
    const handler = this.handlers.get(name);
    if (!handler) throw new Error(`tool not found: ${name}`);
    const start = performance.now();                       // line 61
    const result = await handler(args, options);
    return { result, durationMs: Math.round(performance.now() - start) }; // line 63 — timed
  }
}
```

Line 17 is the gateway contract; line 33 is the implementation used by Studio and
tests. Lines 61-63 record `durationMs` on *every* call — that's the per-tool
latency the trace later reports (`04-agent-evaluation.md`). Note line 55:
`signal?.throwIfAborted()` — cancellation is honored at the tool boundary, not
just in the loop.

**Use case 2 — the per-capability policy.**
`packages/tools/src/tool-policy.ts:5` (type) and `:11` (filter):

```ts
export type ToolPolicy = {                                // line 5
  capabilityId: string;
  allowedTools: readonly string[];
};

export function filterToolsForPolicy(allTools, policy): ModelTool[] { // line 11
  const allowed = new Set(policy.allowedTools);
  return allTools
    .filter((tool) => allowed.has(tool.name))             // ← intersect catalog ∩ allowlist
    .map((tool) => ({ name: tool.name, description: tool.description ?? '', inputSchema: tool.inputSchema }));
}
```

Line 11 is the auth middleware: it intersects the catalog with the role's
allowlist and returns *only* provider-neutral schemas. The model is never
offered a tool outside `allowedTools`.

**Use case 3 — an agent wiring it together.**
`packages/agents/anomaly-monitoring/src/monitoring-agent.ts:12-20` (the policy)
and `:58-59` (applied):

```ts
export const anomalyMonitoringToolPolicy = {              // line 12
  capabilityId: ANOMALY_MONITORING_CAPABILITY_ID,
  allowedTools: ['execute_analytics_eql', 'get_metric_timeseries',
                 'get_segments', 'get_anomaly_context'] as const,  // ← 4 read-only tools
};
// ... inside scan():
const allTools = await this.options.tools.listTools();    // line 58
const toolSchemas = filterToolsForPolicy(allTools, anomalyMonitoringToolPolicy); // line 59
```

The monitoring agent declares a 4-tool least-privilege grant (line 12) and
filters the catalog down to it (line 59) before the loop. The comment on line 11
of that file says it plainly: "Provider adapters only see these tools."

**Use case 4 — the executor seam in the loop.**
`packages/runtime/src/run-agent-loop.ts:21` (the seam type) and `:159` (the call):

```ts
export type ToolExecutor = {                              // line 21
  callTool(name, args, options?): Promise<{ result: unknown; durationMs: number }>;
};
// ... inside the loop:
const { result, durationMs } = await tools.callTool(toolUse.name, toolUse.input, { signal }); // line 159
```

The loop depends on the *interface* (line 21), not the concrete registry — so any
gateway implementing `callTool` plugs in. Line 159 is where the model's emitted
intent becomes an actual call.

**Not yet exercised: MCP (Model Context Protocol).** AptKit defines tools as
`ModelTool` schemas behind a local `ToolRegistry` — direct, in-process tool
definitions, *not* an MCP client/server speaking a wire protocol. The
`ToolRegistry` IS the gateway-style abstraction MCP standardizes (one registry,
many agents, each scoped by policy); MCP is the *interoperability* option AptKit
hasn't adopted. If you needed tools from external/third-party servers, you'd
implement `ToolRegistry` over an MCP client and nothing else in the loop would
change — the `ToolExecutor` seam is exactly the swap point. See SECTION F
(`../06-orchestration-system-design-templates/`).

**Not yet exercised: dynamic tool discovery.** Tools are fixed at registry
construction (`InMemoryToolRegistry` constructor); there's no runtime tool
registration or capability negotiation (the thing MCP's `list_tools` handshake
gives you). See SECTION F.

## Elaborate

**Origin.** Tool calling is the provider-native function-calling loop
(Anthropic's tool use, OpenAI's function calling) generalized: the model emits a
structured request, the host executes, the result returns as a turn. MCP (late
2024) standardizes the *transport* so tools can live in separate servers and be
reused across hosts. AptKit deliberately stays in-process and un-MCP'd because
it owns all its tools — there's no third-party tool to interoperate with yet.

**Adjacent — the registry as the gateway pattern.** "One registry, many callers,
per-caller scoping" is the API-gateway shape. The win is that adding an agent
doesn't touch the registry, and adding a tool doesn't touch the agents —
`filterToolsForPolicy` is the only coupling, and it's pure data.

**Adjacent — why the seam is the safety boundary.** Because the harness runs the
tool (not the model), the harness can enforce read-only-ness, timing,
cancellation, and the policy. All of `05-guardrails-and-control.md` hangs off
this one seam. A tool name in a policy is *not* a capability — the capability is
the handler the host wires behind it (the rubric agent's history tools in
`02-agent-memory-tiers.md` are the worked example).

## Interview defense

**Q: "How do you stop an agent from calling tools it shouldn't?"**

```
  per-capability allowlist, applied BEFORE the loop
  filterToolsForPolicy(catalog, { allowedTools }) → model only sees its slice
  tool-policy.ts:11
```

Anchor: "Each capability has a `ToolPolicy` — an allowlist of tool names. I
intersect the catalog with it before the run, so the model is never even offered
a tool outside its role. Least privilege by construction, not by instruction."

**Q: "Are you using MCP?"**

```
  NO — direct ModelTool schemas behind a local ToolRegistry
  the registry IS the gateway abstraction MCP standardizes
  swap point if needed: implement ToolRegistry over an MCP client
```

Anchor: "No — direct in-process tool definitions behind a registry seam. The
registry is the gateway abstraction MCP standardizes; I haven't adopted MCP
because all my tools are first-party. If I needed third-party tools, I'd
implement `ToolRegistry` over an MCP client and the loop wouldn't change."

**Q: "Who actually runs the tools — the model?"**

```
  intent (model)  ──▶  execution (harness)
  model emits { name, args } ; tools.callTool() runs it (run-agent-loop.ts:159)
```

Anchor: "The model dispatches an action; my harness is the reducer that performs
it. That seam — `callTool` — is where the policy, timing, cancellation, and the
read-only grant all live." This is the load-bearing seam: own execution and you
own safety.

## Validate

- **Reconstruct:** Draw the four layers (model intent → policy → executor seam →
  registry) and label the file:line for the policy filter (`tool-policy.ts:11`)
  and the executor call (`run-agent-loop.ts:159`).
- **Explain:** Why filter the catalog *before* the loop instead of rejecting
  disallowed calls *during* it? (`monitoring-agent.ts:59` — if the tool isn't in
  the offered schema list, the model can't even form the request; rejecting after
  the fact wastes a turn and invites retries.)
- **Apply:** You want to add a third-party data tool from an external MCP server.
  Where does it plug in, and what changes in the loop? (implement `ToolRegistry`
  over an MCP client — `tool-registry.ts:17`; the loop's `ToolExecutor` seam at
  line 21 is unchanged.)
- **Defend:** A teammate says "the rubric agent has `save_judgment`, so the agent
  can mutate state." Is that an AptKit capability? (`rubric-improvement-agent.ts:17` —
  the *name* is allowlisted; the handler is host-provided; AptKit owns the
  interface, not the side effect — and AptKit's first-party analytics tools are
  read-only.)

## See also

- [01-context-engineering.md](01-context-engineering.md) — tool results are a
  context source, capped at 16k
- [02-agent-memory-tiers.md](02-agent-memory-tiers.md) — why a tool name is not a
  memory store AptKit owns
- [05-guardrails-and-control.md](05-guardrails-and-control.md) — the read-only
  tool grant and the budgets that bound tool calls
- `../01-reasoning-patterns/02-agent-loop-skeleton.md` — the executor seam in the
  kernel (the EXECUTE bone)
- `../agent-patterns-in-this-codebase.md` — the tool-gating row in the patterns
  table
- `.aipe/study-ai-engineering/04-agents-and-tool-use/` — tool-calling mechanics
  from first principles
