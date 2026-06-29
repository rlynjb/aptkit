# Tool Calling and MCP

**Industry standard.** "Tool calling," "function calling," "MCP (Model Context Protocol)." Type label: infrastructure (the substrate under every pattern). **In this codebase: yes — `ToolRegistry` + `ToolPolicy` is aptkit's tool layer; the Gemma provider *emulates* tool-calling for a model that has none. No MCP server; direct tool definitions.**

## Zoom out, then zoom in

Tool calling is the connective tissue under every pattern in this guide — ReAct, agentic RAG, and every multi-agent topology run on it. aptkit's tool layer has two notable pieces: a provider-neutral `ToolRegistry` with least-privilege policy filtering, and a striking one — the Gemma provider *fakes* tool-calling because Gemma has no native tool support.

```
  Zoom out — tool calling is the substrate

  ┌─ every pattern runs on tool calls ──────────────────────┐
  │  ReAct · agentic RAG · supervisor-worker · ...           │
  └───────────────────────────┬──────────────────────────────┘
                              ▼
  ┌─ Tool layer ──────────────────────────────────────────────┐
  │  ToolRegistry (define+execute) · filterToolsForPolicy      │ ← we are here
  │  (least-privilege allowlist)                               │
  └───────────────────────────┬──────────────────────────────┘
                              ▼
  ┌─ Provider layer ──────────────────────────────────────────┐
  │  Anthropic (native tools) · ★ Gemma (EMULATED tools) ★     │
  └─────────────────────────────────────────────────────────────┘
```

## Structure pass

**Axis: who emits a tool call, and how is it represented?** Trace it across providers: Anthropic emits native `tool_use` blocks; Gemma emits *JSON text* that the provider parses into a `tool_use` block. The loop never knows the difference — it always sees `ModelToolUseBlock`. The seam: the `ModelProvider` contract normalizes "native tools" and "emulated tools" into one shape, so `runAgentLoop` is provider-agnostic.

## How it works

### Move 1 — the mental model

A tool registry is a typed function table the model can call by name; a policy is an allowlist that scopes which functions a given agent can see. You know how a permissions system filters which actions a role can take? `filterToolsForPolicy` is that, for agent tools.

```
  Tool calling — registry + policy + execution

  agent → filterToolsForPolicy(allTools, policy) → schemas the model sees
  model → emits tool_use(name, args)
  loop  → registry.callTool(name, args) → result → back to model
```

### Move 2 — the three pieces

**Piece 1 — the registry (define + execute).** `InMemoryToolRegistry` holds definitions and handlers, and `callTool` executes by name *and records wall-clock duration* for traces.

```typescript
// packages/tools/src/tool-registry.ts:50-63
async callTool(name, args, options?): Promise<ToolCallResult> {
  options?.signal?.throwIfAborted();
  const handler = this.handlers.get(name);
  if (!handler) throw new Error(`tool not found: ${name}`);
  const start = performance.now();
  const result = await handler(args, options);
  return { result, durationMs: Math.round(performance.now() - start) };  // ← duration for traces
}
```

The `durationMs` here is what feeds the `tool_call_end` trace event in the loop — the registry is also the observability boundary.

**Piece 2 — least-privilege policy.** `filterToolsForPolicy` narrows the full catalog to the allowlist for a capability. The rag-query agent sees exactly one tool; the recommendation agent sees 13 read-only ones.

```typescript
// packages/tools/src/tool-policy.ts:11-22
export function filterToolsForPolicy(allTools, policy): ModelTool[] {
  const allowed = new Set(policy.allowedTools);
  return allTools.filter((tool) => allowed.has(tool.name)).map(...);  // ← only allowed names
}
```

This is the security story: an agent literally cannot call a tool outside its policy, because the model never sees it in the schema list. rag-query's policy is `[search_knowledge_base]` (one tool); even if a prompt injection tried to make it write data, there's no write tool in its schema to call.

**Piece 3 — tool-calling under emulation (the striking part).** Gemma has no native tool support, so the provider fakes the whole protocol in two halves:

```typescript
// OUTBOUND — render tools into the system text, demand JSON (gemma-provider.ts:133-162)
'When a tool is needed, respond with ONLY a single JSON object, no prose:',
'{"tool": "<tool name>", "arguments": { ...arguments... }}',

// INBOUND — parse the model's text back into a tool_use block (gemma-provider.ts:77-83)
const call = parseToolCall(raw);
if (call) return this.toResponse([{ type: 'tool_use', id: ..., name: call.name, input: call.input }], ...);
```

And it hardens the emulation with a retry: if the model produces botched JSON that *looks* like a tool attempt (contains a `{`), it appends a corrective nudge and retries (`gemma-provider.ts:35, 86`), up to `maxToolCallAttempts`. Plain prose is treated as a real answer, not retried. So a model with zero tool-calling capability gets dragged into the same `tool_use` contract every other provider speaks — and `runAgentLoop` never knows the difference.

**MCP — named honestly: not used.** aptkit uses *direct tool definitions* (handlers registered into a registry), not an MCP server. MCP standardizes how agents connect to tools/data so a tool defined once is usable across agents without per-agent integration. aptkit's equivalent is the `ToolRegistry` + `ModelTool` shape — a tool defined once is reusable across agents *within the monorepo*, but it's not the MCP protocol. The decision aptkit made: direct definitions (lower overhead, no protocol server) over MCP (cross-process standardization it doesn't need yet).

### Move 3 — the principle

Tool calling is the substrate every pattern runs on, and the `ModelProvider` contract is what lets one loop drive native-tool and emulated-tool providers identically. The least-privilege policy is the control: an agent can't misuse a tool it can't see. The Gemma emulation is the proof that the abstraction holds — even a tool-less model speaks the tool-call contract once you fake the outbound rendering and inbound parsing.

## Primary diagram

```
  aptkit's tool layer — full frame, including emulation

  ┌─ Agent ────────────────────────────────────────────────┐
  │  filterToolsForPolicy(allTools, policy) → scoped schemas │ tool-policy.ts:11
  └───────────────────────────┬──────────────────────────────┘
                              ▼
  ┌─ Provider (normalizes tool calls) ────────────────────────┐
  │  Anthropic: native tool_use blocks                         │
  │  Gemma:     render tools→system text → parse JSON→tool_use │ gemma-provider.ts
  │             retry on botched JSON (looksLikeToolAttempt)   │
  └───────────────────────────┬──────────────────────────────┘
                              ▼
  ┌─ Registry ────────────────────────────────────────────────┐
  │  callTool(name, args) → { result, durationMs }             │ tool-registry.ts:50
  │  (durationMs feeds the tool_call_end trace)                │
  └─────────────────────────────────────────────────────────────┘
  (no MCP server — direct tool definitions)
```

## Elaborate

Tool calling went from a provider-specific feature to the universal agent substrate, and MCP emerged to standardize tool/data connections across agents and processes. aptkit deliberately stopped short of MCP — its `ToolRegistry` gives intra-monorepo reuse without a protocol server, which is the right scope for a toolkit. The genuinely interesting engineering is the Gemma emulation: it shows the tool-call contract is an *abstraction*, not a model capability — you can synthesize it for a model that lacks it, as long as you own both halves (outbound rendering, inbound parsing) and harden the parse with a retry.

## Interview defense

**Q: How do your agents call tools, and how do you keep them in scope?**
A `ToolRegistry` holds definitions and handlers; `callTool` executes by name and records duration for traces. Least-privilege is enforced by `filterToolsForPolicy` — each agent's policy is an allowlist, so the model never *sees* a tool outside its scope. rag-query's policy is one tool; even a prompt injection can't make it write data, because there's no write tool in its schema.

```
  filterToolsForPolicy → model sees only allowed tools (can't misuse the unseen)
```
*Anchor: the policy is the security boundary — scoping the schema, not just checking at call time.*

**Q: Your local model has no tool-calling — how does that work?**
The Gemma provider emulates it. Outbound, it renders the tool schemas into the system text and demands a JSON object. Inbound, it parses that JSON back into a `tool_use` block, with a retry that nudges the model when the JSON is botched. The loop never knows the difference — it always sees a normalized `tool_use`. That's the proof the tool-call contract is an abstraction, not a model feature.

```
  render tools→text (out) · parse JSON→tool_use (in) · retry on botched JSON
```
*Anchor: own both halves of the protocol and a tool-less model speaks tools.*

**Q: Do you use MCP?**
No — direct tool definitions. MCP standardizes cross-process tool connections; my `ToolRegistry` gives intra-monorepo reuse without a protocol server. Lower overhead, and I don't need cross-process standardization yet.

## See also

- `02-agent-loop-skeleton.md` — the loop that drives tool calls
- `02-agentic-retrieval/01-agentic-rag.md` — search_knowledge_base as a tool
- `05-guardrails-and-control.md` — the policy as part of the control envelope
- `study-ai-engineering/04-agents-and-tool-use/` — tool-calling mechanics (cross-ref)
