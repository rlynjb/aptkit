# Tool Calling
*Tool calling · function calling (Industry standard)*

This is the crown jewel of the repo, so let me say the punchline first: Gemma has **no native tool API**. None. Anthropic and OpenAI hand you a `tools` array and give you back structured `tool_use` blocks. Gemma takes a string and gives back a string. aptkit makes Gemma call tools anyway by *emulating* the whole protocol — rendering tool schemas into the system prompt as plain text, demanding the model reply with JSON, parsing that JSON back into a tool call, nudging it on failure, and gracefully degrading to prose when it just won't comply. That emulation layer is `GemmaModelProvider`, and it's the most interesting code in the codebase.

The mental model is brain and hands. The model is the brain — it reasons and decides "I want to search the knowledge base." The tools are the hands — they actually touch the world. Tool calling is the protocol connecting them. With a native provider the protocol is built in. With Gemma, aptkit builds it.

## Zoom out, then zoom in

Two providers, same `ModelProvider` interface, completely different machinery behind the seam.

```
Same interface, two protocols
┌─────────────────────────────────────────────────────────────────────┐
│  NATIVE (Anthropic / OpenAI)                                          │
│   tools[] ──► provider ──► tool_use{ id, name, input }  ← structured  │
│              (built-in protocol)                                      │
├─────────────────────────────────────────────────────────────────────┤
│  EMULATED (Gemma)                              ★ all the work is here │
│   tools[] ──► render schemas INTO system prompt (text)                │
│           ──► model replies with a string                            │
│           ──► parseToolCall(string) ──► tool_use{...}   ← reconstructed│
│           ──► if junk: RETRY_NUDGE, try again                        │
│           ──► if still junk but prose: return it as the answer       │
└─────────────────────────────────────────────────────────────────────┘
```

The ★ block is pure software — there's no model magic in it. aptkit is *teaching a model with no tool support to speak the tool protocol*, the same way you'd shim an old browser. The rest of the runtime (`runAgentLoop`, the registry) never knows the difference, because both providers return the same `ModelToolUseBlock` shape.

## Structure pass

Trace **failure** through the emulated path, because failure is the whole reason this code is shaped the way it is.

The outbound half (`buildSystemText`, `gemma-provider.ts:133-165`) can't fail loudly — it just renders JSON schemas into text and appends "respond with ONLY a single JSON object." If the model ignores that, you find out *inbound*.

The inbound half is where every failure mode is caught, and the seam flips at each one. `parseToolCall` (`:168-182`) tries to parse the reply as a tool call. Three outcomes branch here: (1) clean JSON → return a `tool_use` block, done. (2) garbage that *looks like* an attempt (`looksLikeToolAttempt`, `:185-187`, the cheap tell is a `{`) → loop and re-prompt with the nudge. (3) plain prose with no brace → that's a real natural-language answer, return it as text. The control flips from "I expect a tool" to "actually that was the final answer" at `:86` — `if (looksLikeToolAttempt(raw)) continue;` — and the fall-through to `:91` is the graceful exit.

## How it works

### Move 1 — the mental model

Native tool calling is a function-call ABI baked into the API. Emulated tool calling is that ABI re-implemented in userland: serialize the call request into the prompt, deserialize the response out of the text.

```
The kernel: serialize out, deserialize back
  ModelTool[] ──serialize──► system prompt text ──► [model] ──► raw string
                                                                    │
  ModelToolUseBlock ◄──deserialize── parseToolCall ◄─────────────────┘
```

### Move 2 — the moving parts. Load-bearing skeleton: pull each piece, name what breaks.

**The renderer (`buildSystemText`) — the outbound serializer.** Removing it: the model never learns the tools exist, so it can never call one. This is the "ABI declaration."

```
Renders each tool as JSON into the prompt, then commands the format
  for each tool → JSON.stringify({ name, description, input_schema })
  + "respond with ONLY a single JSON object: {tool, arguments}"
```

```ts
// packages/providers/gemma/src/gemma-provider.ts:137-161
if (request.tools?.length) {
  const rendered = request.tools
    .map((tool) => JSON.stringify(
      { name: tool.name, description: tool.description ?? '', input_schema: tool.inputSchema },
      null, 2,
    ))
    .join('\n\n');
  parts.push([
    'You can call the following tools:', '', rendered, '',
    'When a tool is needed, respond with ONLY a single JSON object, no prose:',
    '{"tool": "<tool name>", "arguments": { ...arguments... }}',  // ◄── the contract
    'Otherwise, answer the user directly in natural language.',
  ].join('\n'));
}
```

**The parser (`parseToolCall`) with field aliasing — the inbound deserializer.** Removing the aliasing (`obj.tool ?? obj.name ?? obj.tool_name`): a small model that says `"name"` instead of `"tool"` gets rejected even though it did everything right. The aliasing absorbs the model's stylistic drift.

```ts
// packages/providers/gemma/src/gemma-provider.ts:168-182
function parseToolCall(text: string): { name: string; input: Record<string, unknown> } | null {
  let parsed: unknown;
  try { parsed = parseAgentJson(text); } catch { return null; }   // not JSON → not a call
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
  const obj = parsed as Record<string, unknown>;
  const name = obj.tool ?? obj.name ?? obj.tool_name;     // ◄── tolerate 3 field spellings
  const input = obj.arguments ?? obj.input ?? obj.args;   // ◄── tolerate 3 arg spellings
  if (typeof name !== 'string') return null;
  if (!input || typeof input !== 'object' || Array.isArray(input)) return null;
  return { name, input: input as Record<string, unknown> };
}
```

**The retry nudge — the error-correction channel.** Removing it: one malformed reply is fatal; the model gets no second chance to fix its JSON. With it, a botched-but-attempted call earns a corrective re-prompt.

```ts
// packages/providers/gemma/src/gemma-provider.ts:35-37, 62-89
const RETRY_NUDGE =
  'Your previous reply was not a valid tool call. Respond with ONLY a single JSON object: ' +
  '{"tool": "<tool name>", "arguments": { ...arguments... }}';

for (let attempt = 0; attempt < maxAttempts; attempt += 1) {        // maxAttempts default 2
  const messages = attempt === 0
    ? baseMessages
    : [...baseMessages, { role: 'user', content: RETRY_NUDGE }];    // ◄── nudge on retry
  lastResponse = await this.chat({ model: this.defaultModel, messages, stream: false, /*...*/ });
  raw = lastResponse.message?.content ?? '';
  if (wantsTool) {
    const call = parseToolCall(raw);
    if (call) return this.toResponse([{ type: 'tool_use', id: this.nextToolUseId(call.name), name: call.name, input: call.input }], lastResponse);
    if (looksLikeToolAttempt(raw)) continue;   // ◄── looked like a call but broke → retry
  }
  break;
}
```

**The text fallback (`:91`) — the graceful degradation.** Removing it: when the model decides to *answer in prose* instead of calling a tool (which is legal — see the renderer's last line), aptkit would throw or hang waiting for JSON. Instead it returns the prose as the final text. This is what lets the same provider power both tool-using turns and plain-answer turns.

```ts
// packages/providers/gemma/src/gemma-provider.ts:91
return this.toResponse([{ type: 'text', text: raw }], lastResponse);  // ◄── prose is a valid answer
```

### Move 3 — the principle

Treat a weak model's tool calling as a *protocol you implement*, not a feature you assume. Serialize the request, parse the response, retry on malformed, and always have a non-tool exit — because a small model will sometimes just talk to you. The native providers get this for free; the value of the Gemma provider is proving the protocol is the part that matters, not the model.

## Primary diagram

```
Emulated tool calling on Gemma — one complete() call
┌──────────────────────────────────────────────────────────────────────┐
│ buildSystemText: render tools as JSON + "reply with ONLY a JSON obj"   │
│        │                                                               │
│        ▼  attempt 0                                                    │
│   chat(messages) ──► raw string                                        │
│        │                                                               │
│        ▼                                                               │
│   parseToolCall(raw) ──► clean? ──► tool_use{ id, name, input } ──► DONE│
│        │ null                                                          │
│        ▼                                                               │
│   looksLikeToolAttempt('{')? ── yes ──► append RETRY_NUDGE ──► attempt 1│
│        │ no (plain prose)                          (up to maxAttempts)  │
│        ▼                                                                │
│   return { type:'text', text: raw }  ◄── graceful fallback             │
└──────────────────────────────────────────────────────────────────────┘
```

## Elaborate

The runtime above this is provider-blind. `runAgentLoop` reads `toolUsesFromContent(response.content)` (`run-agent-loop.ts:131`) and dispatches `tools.callTool(...)` (`:159`) — it never asks whether the `tool_use` block came from Anthropic's native API or Gemma's reconstruction. That's the payoff of emulation done at the provider seam: the same loop drives a frontier model and a local 9B with identical code. `maxToolCallAttempts` (default 2) bounds the inbound retries so a stubborn model can't spin forever.

## Project exercises

### Validate tool-call arguments against the schema before dispatch

- **Exercise ID:** `EX-TOOL-02a`
- **What to build:** A small validator that checks a parsed `tool_use` block's `input` against the tool's declared `inputSchema` *before* `callTool` runs, returning a structured error (fed back as an observation) instead of letting a malformed-but-parseable call hit the handler. This sits in the Phase 4 tool-calling work between parse and dispatch.
- **Why it earns its place:** `parseToolCall` only checks that `arguments` is an object — it never validates the *contents*. A model can emit `{"tool":"search_knowledge_base","arguments":{"qeury":"x"}}` and it'll dispatch with a typo'd field. Schema validation closes the gap the emulation layer leaves open.
- **Why it earns its place (interview angle):** demonstrates you understand that parse-success ≠ valid-call.
- **Files to touch:** `packages/runtime/src/run-agent-loop.ts` (the dispatch site, `:139-187`), optionally a new helper in `packages/tools/src`.
- **Done when:** A tool call with a missing required field surfaces a validation error as a tool result rather than throwing inside the handler, and a unit test proves it.
- **Estimated effort:** `1–4hr`

## Interview defense

**Q: How does aptkit call tools on a model with no tool API?**

```
render schemas → system prompt ; parse JSON reply → tool_use ; retry ; prose fallback
```

A: It emulates the protocol at the provider seam. `buildSystemText` serializes the tool schemas into the system prompt and demands a single JSON object; `parseToolCall` deserializes the reply back into a `tool_use` block, tolerating field-name drift. Malformed-but-attempted replies get a `RETRY_NUDGE`; plain prose is returned as a real answer. The runtime above never knows it wasn't native. Anchor: `gemma-provider.ts:91` — the prose fallback is what makes it robust.

**Q: What's the part of emulated tool calling people forget?**

```
"reply with JSON" ≠ "always reply with JSON" — the model may just answer
```

A: The graceful text fallback. People wire the parse-and-retry and forget that a small model will sometimes correctly decide it doesn't need a tool and just answer in prose. Without the fall-through at `:91`, that legal behavior becomes a crash. The fallback is also bounded by `maxToolCallAttempts` so retries can't loop forever.

## See also

- [03-react-pattern.md](03-react-pattern.md) — what the loop does with the `tool_use` block this layer produces.
- [01-agents-vs-chains.md](01-agents-vs-chains.md) — where the loop condition that consumes these calls lives.
- [06-error-recovery.md](06-error-recovery.md) — the retry nudge in the full failure-mode table.
