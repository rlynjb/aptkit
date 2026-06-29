# Tool Calling and MCP

**Industry term:** tool calling (function calling) + MCP (Model Context Protocol). *Industry standard.*

## Zoom out, then zoom in

The connective tissue under every pattern — ReAct, agentic RAG, every topology runs on tool calling. aptkit's twist is that its default model, Gemma, has *no native tool calling*, so the provider fakes it. That emulation is the file's load-bearing detail.

```
  Zoom out — tool calling is the substrate; gemma emulates it

  ┌─ Runtime layer ─────────────────────────────────────────────┐
  │  runAgentLoop emits tool_use, runs tools.callTool            │ ← we are here
  └───────────────────────────────┬──────────────────────────────┘
          ┌────────────────────────┴───────────┐
  ┌─ Provider ▼─────────────┐         ┌─ Tools ▼──────────────────┐
  │ anthropic/openai: native│         │ ToolRegistry + ToolPolicy │
  │ gemma: EMULATED          │         │ (the tools to call)       │
  └──────────────────────────┘         └───────────────────────────┘
```

Zoom in: the loop speaks one tool-calling shape (`tool_use` blocks). Cloud providers map that to native function calling. Gemma can't — so `GemmaModelProvider` (`packages/providers/gemma/src/gemma-provider.ts`) renders the tools into the system text and parses a JSON tool call back out. The loop never knows the difference.

## The structure pass

**Layers.** The loop's tool contract (`ModelTool`, `tool_use`) over each provider's tool mechanism (native vs emulated).

**Axis: trust — what can the model reach?** The `ToolPolicy` allowlist scopes it; the model can only call tools the registry exposes *and* the policy permits.

**The seam.** The provider boundary. The loop emits provider-neutral tool intent; each adapter translates. Gemma's adapter does the most translation — it fakes the whole protocol.

## How it works

**Use case in aptkit:** every agent. The clearest is the emulation seam — running an agentic loop on a model that has no tool-calling at all.

### Move 1 — the mental model

Native tool calling is a typed API: you hand the model a tool schema, it returns a structured call. Emulation is the same idea over a text channel — render the schema into the prompt, ask for JSON back, parse it. Like calling a REST endpoint that only speaks strings, so you `JSON.stringify` on the way out and `JSON.parse` on the way in.

```
  Tool calling — native vs emulated

  native (anthropic/openai):  tools=[schema] ──► structured tool_use block
  emulated (gemma):  schema rendered into SYSTEM text
                     ──► model returns JSON string
                     ──► parseToolCall → tool_use block
```

### Move 2 — the walkthrough

**Outbound half: render tools into the system text.** Gemma can't take a `tools` array, so the provider serializes each tool's schema into the prompt and demands a JSON tool call:

```ts
// gemma-provider.ts:137 — outbound emulation: tools become system text
const rendered = request.tools.map((tool) => JSON.stringify(
  { name: tool.name, description: tool.description ?? '', input_schema: tool.inputSchema }, null, 2)
).join('\n\n');
parts.push(['You can call the following tools:', '', rendered, '',
  'When a tool is needed, respond with ONLY a single JSON object, no prose:',
  '{"tool": "<tool name>", "arguments": { ...arguments... }}', ...].join('\n'));
```

**Inbound half: parse messy text back into a tool call.** The model returns a string; `parseToolCall` tolerates the variations a weak model emits (`tool`/`name`/`tool_name`, `arguments`/`input`/`args`):

```ts
// gemma-provider.ts:168 — inbound emulation: messy text → { name, input }
const name = obj.tool ?? obj.name ?? obj.tool_name;
const input = obj.arguments ?? obj.input ?? obj.args;
```

**The parse-retry: emulation needs a retry the native path doesn't.** A weak model often botches the JSON. So when tools are wanted and the reply *looks* like a failed tool call (contains a `{`), Gemma retries with a corrective nudge:

```ts
// gemma-provider.ts:86 — retry only on a botched tool attempt, not on prose
if (looksLikeToolAttempt(raw)) continue;   // RETRY_NUDGE appended next attempt
```

The discipline: only retry a *botched* call (`{` present); plain prose is a real answer, not a failed tool call. Retrying prose would loop on a model that just wanted to answer.

**The loop is provider-agnostic by design.** `runAgentLoop` emits `tool_use` and runs `tools.callTool` regardless of provider. Gemma's adapter makes a tool-call-less model *look* like one that has tools. That's the whole point of the `ModelProvider` seam — the loop is written once, against the contract, and the weakest provider is made to fit it.

**MCP — the protocol angle, not in aptkit.** MCP standardizes how agents connect to tools and data, so a tool defined once is usable across agents without per-agent integration. aptkit uses its own `ToolRegistry` + `ToolDefinition`, not MCP. The decision MCP would address — define a tool once, share it across agents and across processes — aptkit handles in-process via the registry. **MCP is not yet exercised.** The tradeoff if adopted: MCP adds a protocol layer and token overhead, but buys cross-process tool sharing aptkit doesn't currently need (everything is one process).

### Move 3 — the principle

Tool calling is the substrate every agent pattern runs on, and the `ModelProvider` seam lets the loop be written once against one tool contract while each adapter translates. The hard case — a model with no native tool calling — is where the seam earns its keep: Gemma's emulation (render schema out, parse JSON in, retry botched calls) makes a tool-call-less model usable without the loop changing a line. That's deep-module design: the loop's simplicity is paid for by the adapter's complexity.

## Primary diagram

```
  Tool calling across providers — the loop speaks one shape

  runAgentLoop ──tool_use / callTool──┐ (provider-neutral)
                                      │
        ┌─────────────────────────────┼─────────────────────────────┐
        ▼                             ▼                             ▼
  anthropic (native)          openai (native)            gemma (EMULATED)
  tools=[schema]              tools=[schema]              schema→system text
  → structured call           → structured call           → JSON string
                                                           → parseToolCall
                                                           → retry if botched
  ToolPolicy allowlist scopes WHAT each agent may call (trust boundary)
  MCP: not yet exercised (registry is in-process, not a cross-process protocol)
```

## Elaborate

Tool calling is the mechanism that turned LLMs from text generators into agents — the model emits structured intent, your code runs it. Native function calling (Anthropic, OpenAI) makes this a typed API; weaker or older models need emulation over text, which is exactly what aptkit's Gemma provider does. The emulation's two hard parts — robust parsing of messy output and a retry that distinguishes a botched call from a real prose answer — are the production scar tissue of running agents on a local model. MCP is the next layer up: a protocol so tools defined once work across agents and processes; aptkit's in-process registry covers the single-process case without it.

## Interview defense

**Q: Your default model has no tool calling. How does it run an agent loop?**

The Gemma provider emulates it. Outbound, it renders each tool's schema into the system text and demands a JSON tool call. Inbound, it parses the messy reply into a `tool_use` block, tolerating key variations. And it retries — but *only* when the reply looks like a botched tool call (has a `{`), not when it's plain prose, so it doesn't loop on a model that just wanted to answer. The loop never knows the difference.

```
  schema → system text → model JSON → parse → tool_use   (emulation)
  retry only botched calls ({), not prose  (the key discipline)
```

*Anchor: the ModelProvider seam lets the loop be written once; emulation makes the weakest model fit the contract.*

## See also

- [../01-reasoning-patterns/02-agent-loop-skeleton.md](../01-reasoning-patterns/02-agent-loop-skeleton.md) — the loop that consumes tool calls.
- [05-guardrails-and-control.md](05-guardrails-and-control.md) — the ToolPolicy allowlist as a trust boundary.
- Tool-calling / function-calling mechanics: `.aipe/study-ai-engineering/04-agents-and-tool-use/`.
