# Emulated tool-calling — prompt-for-JSON when the model has no native tools

**Industry names:** emulated tool use, JSON-mode function calling, prompted tool-calling · *Industry standard / Project-specific*

## Zoom out, then zoom in

Native tool-calling is a luxury. Anthropic returns structured `tool_use` blocks;
OpenAI returns `tool_calls`. The cloud adapters in `02-tool-calling.md` just rename
a field that's already there. But Gemma2:9b has *no native tools API at all* — you
can't hand it a `tools` array and get a structured call back. So if you want a 9b
local model to drive an agent loop, you have to *emulate* tool-calling: describe the
tools in plain prompt text, demand a JSON tool-call, and parse it back into a real
`tool_use` block yourself. Here's where that emulation sits.

```
  Zoom out — where emulation lives (vs native, which has none)

  ┌─ Agent layer ─────────────────────────────────────────────────┐
  │  builds toolSchemas (ModelTool[]) — vendor-neutral, unchanged  │
  └───────────────────────────────┬────────────────────────────────┘
                                   │ passed into runAgentLoop, then complete()
  ┌─ Provider adapter ─────────────▼────────────────────────────────┐
  │  NATIVE (anthropic/openai): rename field → structured call back │
  │  ★ EMULATED (gemma): render tools INTO prompt text,             │ ← we are here
  │    then PARSE messy text back into a tool_use block ★           │
  └───────────────────────────────┬────────────────────────────────┘
                                   │ POST localhost:11434/api/chat
  ┌─ Local runtime (Ollama) ───────▼────────────────────────────────┐
  │  gemma2:9b — emits free-form TEXT, no structured tool field     │
  └──────────────────────────────────────────────────────────────────┘
```

Zoom in: native tool-calling is a *translation* problem (the structured field is
already in the response; you rename it). Emulated tool-calling is a *decoding*
problem (there is no structured field; you have to prompt for JSON and parse it out
of messy prose). Decoding is a harder, different failure surface — it's exactly
where a weak local model's agent loop stalls. This file is the four-part kernel that
makes it work, and the one distinction inside it that's load-bearing.

## Structure pass

**Layers.** Three, same as native tool-calling: the *agent* (neutral
`ModelTool[]`, untouched), the *runtime loop* (gets a `tool_use` block, runs the
tool — unchanged), and the *provider adapter*. All the emulation is concentrated in
the adapter; nothing above it knows tools are being prompted instead of called.

**Axis — where does structure come from?** Trace it. Native: structure comes from
the *vendor* — the model's response already has a `tool_use` field, the adapter just
relabels it. Emulated: structure comes from the *adapter* — it manufactures
structure on the way out (renders tools into prose) and reconstructs it on the way
back (parses JSON out of text). So the burden of "make this look structured" is
quarantined entirely inside `GemmaModelProvider`; the loop above it is identical
either way.

**Seam.** The seam is still `implements ModelProvider`, and that's the point: the
emulated adapter satisfies the exact same port. The runtime loop calls
`complete()`, gets back a neutral `ModelContentBlock[]` with a real `tool_use`
block, and runs the tool — it cannot tell the call was emulated. Everything
prompt-and-parse lives *behind* this seam, which is why the `RagQueryAgent` uses
Gemma to call `search_knowledge_base` with zero agent-side changes.

## How it works

You've parsed a command out of free-form text before — a chatbot that scans a reply
for `/deploy prod` and runs it, or a regex that pulls a JSON blob out of an LLM's
chatty answer. Emulated tool-calling is that, made rigorous: instead of *hoping* the
model emits parseable structure, you *instruct* it to (render the tools, demand
JSON), then parse defensively, and — the part that separates it from a hack — retry
with a correction when the parse fails, but *only* when the model actually tried.

### Move 1 — the mental model

```
  Emulated tool-call — the round trip the adapter manufactures

  OUTBOUND ──►  ┌──────────────────────────────────────────┐
                │ system text: "You can call these tools:   │  RENDER tools
                │  {name, description, input_schema}…       │  into the prompt
                │  respond with ONLY {tool, arguments}"     │
                └──────────────────┬───────────────────────┘
                                   │ Gemma emits free-form TEXT
                                   ▼
  INBOUND  ◄──  ┌──────────────────────────────────────────┐
                │ "Sure! ```json {tool,arguments} ```"      │  messy blob
                │   parseAgentJson → { name, input }        │  PARSE back
                └──────────────────┬───────────────────────┘
                                   │ wrap as real tool_use block
                                   ▼
                ┌──────────────────────────────────────────┐
                │ { type:'tool_use', id:'gemma-<name>-<n>', │  loop runs it,
                │   name, input }  ← loop can't tell it was │  unchanged
                │   emulated                                │
                └──────────────────────────────────────────┘
```

The adapter manufactures the structure the model can't produce on its own: it
*writes* the tool menu into the prompt, then *reads* the model's JSON back into the
neutral `tool_use` shape the loop already understands.

### Move 2 — the load-bearing skeleton

Strip emulated tool-calling to its kernel and four parts remain. Name each by what
*breaks* if you drop it — that's how you know none is optional.

```
  The four-part kernel — drop any one, and here's what breaks

  ┌─────────────────────────────────────────────────────────────────┐
  │ 1. RENDER tools into the prompt   drop → model doesn't know the  │
  │    (buildSystemText)                     tools exist; never calls │
  ├─────────────────────────────────────────────────────────────────┤
  │ 2. PARSE JSON back to a tool_use  drop → you get a JSON STRING,  │
  │    (parseToolCall)                       not a call; loop STALLS  │
  ├─────────────────────────────────────────────────────────────────┤
  │ 3. PROSE-vs-'{' distinction       drop → you nudge a good prose  │
  │    (looksLikeToolAttempt)                answer into oblivion, OR │
  │                                          never let it just answer │
  ├─────────────────────────────────────────────────────────────────┤
  │ 4. BOUNDED parse-retry            drop → infinite nudge loop,    │
  │    (loop in complete, max=2)             burning tokens on a 9b   │
  │                                          model that can't comply  │
  └─────────────────────────────────────────────────────────────────┘
```

#### Part 1 — render the tools into the prompt (outbound)

Gemma can't take a native `tools` array, so `buildSystemText` serializes each tool
(`name`, `description`, `input_schema`) as JSON straight into the system text, then
appends the contract: respond with ONLY `{"tool":"<name>","arguments":{...}}`, no
prose; otherwise answer directly.

```
  buildSystemText — make the model AWARE tools exist

  system = [ request.system,
             "You can call the following tools:",
             JSON.stringify({name, description, input_schema}) per tool,
             'respond with ONLY a single JSON object, no prose:',
             '{"tool":"<tool name>","arguments":{ ... }}',
             'Otherwise, answer the user directly.' ].join('\n')
        │
        └─ drop this and the model has no idea the tools exist —
           it can't call what it was never told about.
```

The boundary condition: this also has to say "otherwise answer directly," or the
model will try to force a tool call onto a question that doesn't need one — the
inverse failure of part 3.

#### Part 2 — parse the JSON back (inbound)

`parseToolCall` runs `parseAgentJson(text)` to extract a JSON object from messy
model output (prose, markdown fences, whatever), tolerates key aliases
(`tool|name|tool_name`, `arguments|input|args`), and returns `{name, input}` — or
`null` when it isn't a call. On success the adapter emits a *real* `tool_use` block
with a synthetic id.

```
  parseToolCall — turn text back into structure

  text ─► parseAgentJson(text)  ─► obj
            │ (throws? → null)
            ▼
       name = obj.tool ?? obj.name ?? obj.tool_name     ← alias tolerance
       input= obj.arguments ?? obj.input ?? obj.args
            │ name string AND input object?
            ├─ yes → { name, input }  → tool_use block (id 'gemma-<name>-<n>')
            └─ no  → null
        │
        └─ drop this and the model's call is just a JSON STRING in a text
           block — the loop sees no tool_use, never runs the tool, stalls.
```

The boundary condition: the alias tolerance and the synthetic id are *hardening*,
not kernel — a weak model will phrase the same call three ways, and the runtime loop
still requires *some* id to correlate the eventual `tool_result`.

#### Part 3 — the prose-vs-`{` distinction (load-bearing)

This is the sharp one. After a failed parse, should you retry? Only if the model
*tried* to call a tool. `looksLikeToolAttempt` is the cheap tell: does the text
contain a `{`? If yes, it was a botched JSON call — retry. If no — plain prose — it's
a *real answer*, return it, do not retry.

```
  looksLikeToolAttempt — the distinction that's load-bearing

  parse failed. text contains '{' ?
     ├─ YES → looked like a botched tool call → RETRY with a nudge
     └─ NO  → plain prose → it's a REAL ANSWER → return it, no retry
        │
        └─ drop this and you pick one of two disasters:
           • retry EVERYTHING → you nudge "It is sunny in Paris." into
             oblivion, demanding JSON the user never wanted
           • retry NOTHING → a botched call is never corrected; the
             loop stalls on the first malformed blob
```

The boundary condition: `{` is a heuristic, not a proof — a prose answer that
happens to contain a brace gets one wasted retry. That's an accepted cost; the
alternative (parsing intent perfectly) is the exact problem you're trying to avoid.

#### Part 4 — bounded parse-retry

When part 3 says "retry," `complete()` re-asks Gemma with a corrective `RETRY_NUDGE`
appended ("Your previous reply was not a valid tool call. Respond with ONLY a single
JSON object…") — but *bounded* by `maxToolCallAttempts` (default 2). After the bound,
return the raw text as a real answer.

```
  Bounded retry in complete() — correct, but don't spin forever

  for attempt in 0..maxAttempts:
    messages = attempt==0 ? base : base + RETRY_NUDGE   ← corrective nudge
    raw = chat(messages)
    call = parseToolCall(raw)
    if call → return tool_use block                      ← success, stop
    if looksLikeToolAttempt(raw) → continue              ← part 3 gate
    break                                                ← prose, stop
  return text block(raw)                                 ← bound hit, give up
        │
        └─ drop the BOUND and a 9b model that simply can't emit valid JSON
           gets nudged forever — an infinite loop burning tokens and time.
```

The boundary condition: `maxAttempts` is `wantsTool ? maxToolCallAttempts : 1` — if
no tools were offered, there's nothing to retry, so it runs exactly once.

### Move 3 — the principle

Manufacture the structure the model can't, but never mistake an answer for a failure.
The kernel is render + parse + the prose distinction + the bound — and the
distinction is what separates emulation from a token-burning loop. Keep all four
behind the `ModelProvider` seam so the agent loop above never learns the call was
emulated. The native adapters get structure for free; the emulated adapter earns it,
and earns it *bounded*.

## Primary diagram

The full emulation, every part labelled, from offered tools to a runnable `tool_use`.

```
  Emulated tool-calling — full picture, one complete() call

  AGENT: toolSchemas: ModelTool[]   (neutral, identical to native path)
        │
        ▼ complete({ system, messages, tools })
  ┌─ GemmaModelProvider ───────────────────────────────────────────────┐
  │ ① buildSystemText: render {name,description,input_schema} + contract│
  │      "respond with ONLY {tool,arguments}; else answer directly"     │
  │        │ POST localhost:11434/api/chat                              │
  │        ▼ raw = messy free-form text                                 │
  │ ② parseToolCall(raw): parseAgentJson → aliases → {name,input}|null │
  │        │                                                            │
  │   call? ─┬─ YES → tool_use { id:'gemma-<name>-<n>', name, input }  │ ──► loop runs it
  │          └─ NO  → ③ looksLikeToolAttempt(raw)? ('{' present)        │
  │                       ├─ YES → ④ attempt<max? append RETRY_NUDGE,   │
  │                       │          loop ↑   else → text block(raw)    │
  │                       └─ NO  → text block(raw)  (real prose answer) │
  └────────────────────────────────────────────────────────────────────┘
```

## Implementation in codebase

**Use cases.** The `RagQueryAgent` runs on Gemma and *must* call
`search_knowledge_base` before answering — emulated tool-calling is the only reason
that works on a model with no native tools API. The agent declares the tool as a
neutral `ModelTool` and never knows it's being prompted, not called
(`rag-query-agent.ts:62-83`). The tool's own `minTopK` floor is a *second* defense
against the weak model — even if Gemma emulates a call with `top_k: 1`, the tool
clamps it up so a multi-part question doesn't starve its own retrieval.

**Part 1 — render tools into the prompt**,
`packages/providers/gemma/src/gemma-provider.ts:133-165`:

```
  packages/providers/gemma/src/gemma-provider.ts  (lines 137-161)

  if (request.tools?.length) {
    const rendered = request.tools.map((tool) =>
      JSON.stringify({ name: tool.name,
                       description: tool.description ?? '',
                       input_schema: tool.inputSchema }, null, 2)  ← tool → JSON in PROMPT
    ).join('\n\n');
    parts.push([ 'You can call the following tools:', '', rendered, '',
      'When a tool is needed, respond with ONLY a single JSON object, no prose:',
      '{"tool": "<tool name>", "arguments": { ...arguments... }}',
      'Otherwise, answer the user directly in natural language.' ].join('\n'));
  }
       │
       └─ The "otherwise answer directly" line is what lets a no-tool-needed
          question get a plain answer instead of a forced, broken call.
```

**Part 2 — parse JSON back into a call**,
`packages/providers/gemma/src/gemma-provider.ts:167-182`:

```
  packages/providers/gemma/src/gemma-provider.ts  (lines 168-182)

  function parseToolCall(text): { name; input } | null {
    let parsed;
    try { parsed = parseAgentJson(text); } catch { return null; }   ← pull JSON from mess
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
    const obj = parsed as Record<string, unknown>;
    const name  = obj.tool ?? obj.name ?? obj.tool_name;            ← alias tolerance
    const input = obj.arguments ?? obj.input ?? obj.args;
    if (typeof name !== 'string') return null;
    if (!input || typeof input !== 'object' || Array.isArray(input)) return null;
    return { name, input };
  }
       │
       └─ on success the caller wraps this in a real tool_use block with a
          synthetic id 'gemma-<name>-<n>' (line 81, 110-114) so the loop can
          correlate the eventual tool_result.
```

**Part 3 + 4 — the distinction and the bound, in `complete()`**,
`packages/providers/gemma/src/gemma-provider.ts:52-92`:

```
  packages/providers/gemma/src/gemma-provider.ts  (lines 57-91)

  const maxAttempts = wantsTool ? this.maxToolCallAttempts : 1;     ← no tools → 1 shot
  for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
    const messages = attempt === 0
      ? baseMessages
      : [...baseMessages, { role: 'user', content: RETRY_NUDGE }];  ← ④ corrective nudge
    lastResponse = await this.chat({ model, messages, stream: false });
    raw = lastResponse.message?.content ?? '';
    if (wantsTool) {
      const call = parseToolCall(raw);
      if (call) return this.toResponse([{ type:'tool_use', ... }]); ← ② success, stop
      if (looksLikeToolAttempt(raw)) continue;                       ← ③ '{' → retry
    }
    break;                                                           ← ③ prose → stop
  }
  return this.toResponse([{ type: 'text', text: raw }], lastResponse); ← give up → answer
       │  looksLikeToolAttempt: return text.includes('{')  (line 185-187)
       └─ the '{' gate is load-bearing: prose answers break out immediately
          (no wasted nudge); only brace-bearing failures retry, up to the bound.
```

**The tool-side floor — defense in depth against a weak caller**,
`packages/retrieval/src/search-knowledge-base-tool.ts:50-81`:

```
  packages/retrieval/src/search-knowledge-base-tool.ts  (lines 50-81)

  const minTopK = Math.max(1, options.minTopK ?? 1);
  ...
  const requestedTopK = typeof args.top_k === 'number' && args.top_k > 0 ? args.top_k : defaultTopK;
  const topK = Math.max(requestedTopK, minTopK);   ← clamp UP a weak model's top_k:1
       │
       └─ emulation gets the call THROUGH; this stops the weak model from
          starving its OWN retrieval by passing top_k:1 on a multi-part question.
```

## Elaborate

Before native function-calling APIs existed (pre-2023), *every* tool-using LLM
worked this way: you described tools in the prompt and parsed the model's text back
out — ReAct's original "Action: search[query]" format is prompt-and-parse, not a
structured API. Native tool-calling made the technique invisible for frontier
models, but it never went away for open-weights models that lack the API. So
emulated tool-calling isn't a workaround — it's the original technique, still
load-bearing wherever the model can't return structure on its own.

The contrast with `02-tool-calling.md` is the whole lesson. There, the cloud
adapters do *translation*: the `tool_use` field already exists in the response;
`toAnthropicTool`/`toOpenAITool` just rename it. Here, the adapter does *decoding*:
there is no field, so it prompts for JSON and parses it back, then guards the parse
with a prose distinction and a retry bound. Translation can't really fail — the
structure is already there. Decoding fails constantly on a weak model, which is
precisely why the agent loop stalls on local models and why the four-part kernel
(especially the bound) exists. AptKit's choice to keep all of it behind the same
`ModelProvider` seam means the `RagQueryAgent` doesn't pay for any of this
complexity — it asks for a tool and gets a `tool_use` block, native or not.

Adjacent: native tool-calling, the thing being emulated
(`02-tool-calling.md`); the port that hides the emulation
(`../01-llm-foundations/08-provider-abstraction.md`); when to accept this complexity
at all (`../01-llm-foundations/10-local-vs-cloud-models.md`); the parse-retry as a
species of error recovery (`06-error-recovery.md`).

## Project exercises

*Provenance: Phase 4 — Agents and tool use (C4.x). No `aieng-curriculum.md`
present; IDs are by-phase convention. Case A — emulation is implemented; these
harden the decoder.*

### Exercise — harden the parser against fenced and multi-object output

- **Exercise ID:** `[A4.7]` Phase 4, emulated tool-calling
- **What to build:** Extend `parseToolCall`/`parseAgentJson` handling so a real
  Gemma reply that wraps the JSON in a markdown fence (` ```json … ``` `) *or* emits
  multiple JSON objects (pick the first valid tool-shaped one) still decodes to a
  clean `tool_use`. Add a test that feeds the recorded messy blob from
  `gemma-provider.test.ts` and asserts a clean `tool_use` out.
- **Why it earns its place:** Fenced and multi-object output are the two most common
  ways a 9b model "almost" emits a call. Hardening the decoder is exactly the work
  that keeps the agent loop from stalling — it's the kernel's part 2 in practice.
- **Files to touch:** `packages/providers/gemma/src/gemma-provider.ts`,
  `packages/providers/gemma/test/gemma-provider.test.ts`.
- **Done when:** a test proves a fenced/multi-object real-Gemma blob parses to a
  single correct `tool_use` block, and the prose-answer test still passes (no
  regression in part 3).
- **Estimated effort:** `1–4hr`

### Exercise — make the retry budget configurable per-tool

- **Exercise ID:** `[A4.8]` Phase 4, bounded parse-retry
- **What to build:** Let `maxToolCallAttempts` vary by tool (e.g. a
  structured-argument tool like `search_knowledge_base` gets more nudges than a
  trivial one), instead of a single provider-wide bound.
- **Why it earns its place:** It forces you to reason about part 4 — the bound is
  cost control, and different tools have different "is this model ever going to get
  it right?" odds. You feel where the token-burn risk lives.
- **Files to touch:** `packages/providers/gemma/src/gemma-provider.ts`,
  `packages/providers/gemma/test/gemma-provider.test.ts`.
- **Done when:** a test shows a per-tool budget honored (more attempts for one tool,
  fewer for another) and the infinite-loop guard still holds.
- **Estimated effort:** `1–4hr`

## Interview defense

**Q: How do you give tool-use to a model with no native tools API?**
"You emulate it — prompt for JSON, parse it back. I'd draw the round trip:"

```
  render tools INTO prompt ─► model emits TEXT ─► parse JSON back
   (buildSystemText)            "```json{tool,        (parseToolCall)
                                  arguments}```"       → real tool_use block
   gate: retry only if it          (loop runs it, can't tell it was emulated)
   looked like a call ('{'),
   bounded by maxToolCallAttempts
```

"Four parts, and each is load-bearing. Render the tools into the system text so the
model knows they exist. Parse the messy reply back into a `tool_use` block —
`parseToolCall` at `gemma-provider.ts:168`, tolerating `tool|name|tool_name`
aliases. The sharp part: only retry if the text contains a `{` — plain prose is a
*real answer*, not a failed call, so you don't nudge 'It is sunny in Paris' into
oblivion. And bound the retries, or a 9b model that can't emit valid JSON gets
nudged forever. Contrast native: Anthropic and OpenAI return the structure already,
so the adapter just renames a field — no parsing, no retry."
*Anchor: native is translation; emulation is decoding — and decoding needs the prose distinction and the bound.*

**Q: Why is the prose-vs-`{` check load-bearing?**
"Because without it you pick one of two failures. Retry everything, and you punish a
perfectly good prose answer — demanding JSON the user never asked for, possibly
losing the answer entirely. Retry nothing, and a botched JSON call is never
corrected, so the loop stalls on the first malformed blob. The `{` heuristic splits
those cases cheaply — `looksLikeToolAttempt` at `gemma-provider.ts:185`. It's a
heuristic, not a proof, so a prose answer with a stray brace costs one wasted retry —
an accepted price, because parsing intent perfectly is the very problem I'm avoiding."
*Anchor: the distinction is what keeps emulation from either eating answers or spinning forever.*

## Validate

- **Reconstruct:** From memory, name the four parts of the kernel and what breaks if
  you drop each. Check against `complete()` and its helpers,
  `gemma-provider.ts:52-92`, `133-187`.
- **Explain:** Why does a plain-prose Gemma reply *not* trigger a retry, while a
  reply containing `{` does? (Prose is a real answer; a brace signals a botched tool
  call worth correcting — `looksLikeToolAttempt`, `gemma-provider.ts:86, 185-187`.
  The test at `gemma-provider.test.ts:112-124` pins it.)
- **Apply:** Gemma returns `Here you go: {oops not valid json`. What does the
  adapter do? (Parse fails, but `{` is present, so it retries with `RETRY_NUDGE` up
  to `maxToolCallAttempts`; if still unparseable it returns the raw text —
  `gemma-provider.ts:78-91`. Test: `gemma-provider.test.ts:81-94`.)
- **Defend:** Why does `search_knowledge_base` clamp `top_k` up to `minTopK` instead
  of trusting the model's argument? (Emulation gets the call *through*, but a weak
  model can still pass `top_k: 1` and starve its own retrieval on a multi-part
  question; the floor is defense-in-depth — `search-knowledge-base-tool.ts:51, 81`.)

## See also

- [02-tool-calling.md](02-tool-calling.md) — native tool-calling, the thing being emulated
- [06-error-recovery.md](06-error-recovery.md) — the parse-retry as a recovery turn
- [03-react-pattern.md](03-react-pattern.md) — the loop that runs the decoded tool_use block
- [../01-llm-foundations/08-provider-abstraction.md](../01-llm-foundations/08-provider-abstraction.md) — the port that hides whether a call was emulated
- [../01-llm-foundations/10-local-vs-cloud-models.md](../01-llm-foundations/10-local-vs-cloud-models.md) — when the weak local model that needs emulation earns its place
