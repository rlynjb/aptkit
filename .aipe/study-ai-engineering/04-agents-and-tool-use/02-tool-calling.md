# Tool calling

**Subtitle:** Tool use / function calling · emulated for a model without it · *Industry standard (with a project-specific twist)*

## Zoom out, then zoom in

Tool calling is how the model reaches the world. In aptkit the twist is that the
default model — local Gemma — *has no native tool API*. So the tool-call mechanism
isn't a vendor feature; it's emulated inside the Gemma provider, between the agent
loop and Ollama.

```
  Zoom out — where tool calling lives

  ┌─ Agent loop ───────────────────────────────────────────────┐
  │  sends tools[], reads tool_use blocks back, runs the tool   │
  └───────────────────────────┬─────────────────────────────────┘
                              │ ModelRequest { tools }
  ┌─ Gemma provider ──────────▼─────────────────────────────────┐
  │  ★ EMULATION ★ render tools into system prompt;             │ ← we are here
  │  parse a JSON tool call back out of the text                │
  └───────────────────────────┬─────────────────────────────────┘
                              │ HTTP /api/chat (stream:false)
  ┌─ Ollama / gemma2:9b ──────▼─────────────────────────────────┐
  │  plain text in, plain text out — no tools concept           │
  └──────────────────────────────────────────────────────────────┘
```

Now zoom in. With Claude or GPT you pass a `tools` array and get back a structured
`tool_use` block — the provider does the work. Gemma gives you neither. aptkit's
job is to make Gemma *look like* it has tool-calling to everything above it, so the
exact same agent loop runs on Gemma, Claude, or GPT. The brain (model) names a
tool; the hands (your code) run it. With Gemma you also have to *teach the brain
how to ask*.

## Structure pass

**Layers.** Agent loop (vendor-neutral) → provider (vendor-specific) → model.

**Axis — control of the tool-call format.** Who guarantees the tool call is
well-formed? Trace it: with Claude, the provider guarantees it (native). With
Gemma, *nobody* does — the model emits free text that may or may not be a valid
JSON tool call, so the provider must parse, validate, and retry. The axis
"is the tool call structured by construction?" flips at the provider seam.

**Seam.** `ModelProvider.complete()` (`model-provider.ts:54`). Above it, the loop
sends `tools` and reads `tool_use` blocks, never knowing how they were produced.
Below it, the Gemma provider does the entire emulation. That seam is why emulation
is invisible to the agents.

## How it works

### Move 1 — the mental model

A tool call is a *typed request the model emits and your code fulfills*. You know
how a form `<input>` doesn't submit itself — it produces a value your handler
acts on? Same here: the model produces `{tool, arguments}`, your code runs the
tool, the result goes back as the next message. The model is the brain, tools are
the hands.

```
  Tool calling — the brain/hands loop

  model: "{tool: search, arguments:{query:'ORM'}}"   ← brain names the tool
       │
  your code: registry.callTool('search', {query:'ORM'})   ← hands run it
       │
  result back as a message ─► model reads it ─► decides next   ← brain continues
```

### Move 2 — the emulation, step by step

**Step 1 — render tools into the system prompt (outbound half).** Gemma can't take
a `tools` array, so `buildSystemText` (`gemma-provider.ts:133`) serializes each
tool into the system text and demands a JSON reply:

```ts
parts.push([
  'You can call the following tools:', '',
  rendered,                                   // JSON.stringify of {name, description, input_schema}
  '',
  'When a tool is needed, respond with ONLY a single JSON object, no prose:',
  '{"tool": "<tool name>", "arguments": { ...arguments... }}',
  'Otherwise, answer the user directly in natural language.',
].join('\n'));
```

The model's only channel is text, so the tool menu *becomes* text and the
expected reply format is spelled out. This is the half native providers hide.

```
  Outbound — tools become prompt text

  loop sends tools[] ─► buildSystemText ─► system prompt:
     "You can call: { name, description, input_schema } …
      reply with ONLY {tool, arguments}"
                              │
                              ▼  HTTP /api/chat
                           Gemma
```

**Step 2 — parse a tool call back out (inbound half).** Gemma replies with text.
`parseToolCall` (`gemma-provider.ts:168`) tries to extract a `{tool, arguments}`
object, tolerating the messy shapes a weak model emits:

```ts
function parseToolCall(text) {
  let parsed;
  try { parsed = parseAgentJson(text); }   // strips ```json fences, scans for {…}
  catch { return null; }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
  const name  = obj.tool ?? obj.name ?? obj.tool_name;       // accept aliases
  const input = obj.arguments ?? obj.input ?? obj.args;      // accept aliases
  if (typeof name !== 'string') return null;
  if (!input || typeof input !== 'object' || Array.isArray(input)) return null;
  return { name, input };
}
```

Notice the alias tolerance: a 9B model won't reliably say `tool`/`arguments`, so
the parser also accepts `name`/`tool_name` and `input`/`args`. When it parses, the
provider returns a real `tool_use` content block (`gemma-provider.ts:80`) — exactly
what Claude would have returned natively.

```
  Inbound — text becomes a tool_use block

  Gemma text ─► parseAgentJson (fence-strip + brace-scan) ─► {tool, arguments}?
       │ yes                                         │ no
       ▼                                             ▼
  return [{type:'tool_use', name, input}]      maybe retry / fall back to text
```

**Step 3 — retry with a nudge, bounded.** When the model *tried* a tool call and
botched the JSON, the provider retries with a corrective message — but only a
bounded number of times. The retry loop (`gemma-provider.ts:62`):

```ts
const maxAttempts = wantsTool ? this.maxToolCallAttempts : 1;   // default 2
for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
  const messages = attempt === 0
    ? baseMessages
    : [...baseMessages, { role: 'user', content: RETRY_NUDGE }];   // corrective nudge
  lastResponse = await this.chat({ ... });
  raw = lastResponse.message?.content ?? '';
  if (wantsTool) {
    const call = parseToolCall(raw);
    if (call) return /* tool_use block */;
    if (looksLikeToolAttempt(raw)) continue;   // a '{' is the tell → retry
  }
  break;
}
```

`RETRY_NUDGE` (`:35`) literally re-states the format: "Your previous reply was not
a valid tool call. Respond with ONLY a single JSON object…". The bound matters —
without `maxToolCallAttempts` you'd loop forever on a model that can't produce
valid JSON.

```
  Retry — bounded nudge

  attempt 0: parse? ─yes─► tool_use
       │ no, but text has '{' (looksLikeToolAttempt)
       ▼
  attempt 1: + RETRY_NUDGE ─► parse? ─yes─► tool_use
       │ no
       ▼
  give up tooling → return the text as a real answer (graceful fallback)
```

**Step 4 — graceful text fallback.** This is the load-bearing decision people
forget. If the reply is plain prose (no `{`), it's a *real answer*, not a failed
tool call — `looksLikeToolAttempt` returns false and the loop `break`s, returning
the text (`gemma-provider.ts:86,91`). The provider never punishes the model for
correctly choosing to answer directly.

### Move 3 — the principle

Make the weakest model look like the strongest at the seam, and everything above
the seam gets simpler. aptkit doesn't fork the agent loop per provider — it forces
every provider to satisfy one contract (`tool_use` blocks in, text or tool_use
out), and pays the emulation cost once, inside the Gemma adapter. The interview
signal is naming the bounded retry and the graceful fallback: they're what keep
emulation from turning into an infinite loop or a false failure.

## Primary diagram

```
  Emulated tool calling — the whole mechanism

  ┌─ Agent loop (vendor-neutral) ──────────────────────────────────────┐
  │  ModelRequest{tools}  ───────────────►  reads tool_use blocks back  │
  └───────────────┬───────────────────────────────────▲────────────────┘
                  │                                    │
  ┌─ Gemma provider (gemma-provider.ts) ───────────────┴────────────────┐
  │  OUT: buildSystemText — tools → system prompt + "reply {tool,args}"  │
  │  IN:  parseToolCall — parseAgentJson, alias-tolerant {tool|name,...} │
  │  RETRY: maxToolCallAttempts(2) + RETRY_NUDGE if looksLikeToolAttempt │
  │  FALLBACK: plain prose → return as text (a real answer)              │
  └───────────────┬───────────────────────────────────▲────────────────┘
                  │ HTTP /api/chat stream:false         │ text
  ┌─ Ollama gemma2:9b ─────────────────────────────────┴────────────────┐
  │  no tools concept — text in, text out                                │
  └──────────────────────────────────────────────────────────────────────┘
```

## Elaborate

Native tool-calling (OpenAI functions, Anthropic tool use) trains the model to
emit structured calls and the provider guarantees the shape. Open local models
mostly lack it, so the field's answer is prompt-based emulation — and the hard part
is never the happy path, it's the failure handling: malformed JSON, the model
ignoring the format, the model answering in prose when it should. aptkit's
provider handles all three. Contrast with the Anthropic provider
(`packages/providers/anthropic/src/anthropic-provider.ts`), which just maps
`request.tools` to the SDK's native `tools` — no emulation needed. Read
`03-react-pattern.md` for how the loop uses these calls, and
`06-error-recovery.md` for what happens when the *tool* (not the model) fails.

## Project exercises

### Add a tool-arg schema check to the Gemma parser
- **Exercise ID:** —  (no curriculum file in repo)
- **What to build:** after `parseToolCall` succeeds, validate `input` against the
  tool's `inputSchema` (required keys present, types right); on mismatch, treat it
  like a botched call and retry with a nudge naming the missing field.
- **Why it earns its place:** a weak model emits the right tool with wrong args
  more often than wrong JSON; schema-checking the args is the next layer of
  emulation robustness and shows you understand the failure distribution.
- **Files to touch:** `packages/providers/gemma/src/gemma-provider.ts`,
  `packages/providers/gemma/test/`.
- **Done when:** a recorded transport that returns `{tool:'search'}` with a missing
  `query` triggers a nudge naming `query`, then succeeds on the retry.
- **Estimated effort:** `1–4hr`

## Interview defense

**Q: "Your default model has no tool-calling. How do agents still work?"**
The Gemma provider emulates it at the `ModelProvider` seam. Outbound: it renders
the tools into the system prompt and asks for a single JSON `{tool, arguments}`.
Inbound: it parses that JSON back into a `tool_use` block — alias-tolerant, because
a 9B model won't reliably use the exact keys. So the agent loop sees the same
`tool_use` blocks it would from Claude; the emulation is invisible above the seam.

```
  tools → prompt text → Gemma → {tool,args} text → parse → tool_use block
   native-looking output, produced by a model with no native tools
```
Anchor: *emulate at the provider seam so the loop never forks per vendor.*

**Q: "What stops it from looping forever on a model that can't produce JSON?"**
Two bounds. `maxToolCallAttempts` (default 2) caps the nudge retries. And
`looksLikeToolAttempt` — a `{` in the reply — distinguishes a *botched* tool call
(retry) from a *deliberate* prose answer (don't retry, return it). The combination
is the load-bearing part: it both bounds the failure and avoids punishing a correct
text answer.

```
  parse fail + has '{'  → retry (bounded to 2)
  parse fail + no '{'   → it's a real answer → return text (graceful fallback)
```
Anchor: *bounded retry + graceful text fallback — the part people forget.*

## See also

- `01-llm-foundations/01-what-an-llm-is.md` — the `tool_use` content block
- `03-react-pattern.md` — the loop that consumes tool calls
- `04-tool-routing.md` — which tools the model is even allowed to call
- `06-error-recovery.md` — when the tool itself fails or the model loops
