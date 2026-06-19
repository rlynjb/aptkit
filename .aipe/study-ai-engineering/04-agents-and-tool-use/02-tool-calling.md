# Tool calling (the brain/hands split)

**Industry names:** tool use, function calling, tool calling · *Industry standard*

## Zoom out, then zoom in

A model can't run code. It can't hit your API, read your database, or call a
function. All it can do is emit text — including a *structured request* that says
"please call `get_metric_timeseries` with these arguments." Your code reads that
request, runs the tool, and hands the result back. That hand-off is tool calling,
and it sits right between the loop and the provider.

```
  Zoom out — where tool calling lives

  ┌─ Agent layer (packages/agents/*) ─────────────────────────────┐
  │  builds toolSchemas (ModelTool[]) from the registry            │
  └───────────────────────────────┬────────────────────────────────┘
                                   │ passed into
  ┌─ Runtime layer (runAgentLoop) ─▼────────────────────────────────┐
  │  ★ tool-use block in → run tool → tool-result block out ★       │ ← we are here
  └───────────────────────────────┬────────────────────────────────┘
                                   │ ModelProvider.complete()
  ┌─ Provider layer (adapters) ────▼────────────────────────────────┐
  │  toAnthropicTool / toOpenAITool ── translate to vendor shapes   │
  └───────────────────────────────┬────────────────────────────────┘
                                   │ HTTPS
  ┌─ Vendor API ───────────────────▼────────────────────────────────┐
  │  Anthropic Messages / OpenAI Chat Completions                   │
  └──────────────────────────────────────────────────────────────────┘
```

Zoom in: the model is the **brain**, your code is the **hands**. The brain
decides *what* to call and with *what arguments*; the hands actually call it. The
question this file answers: what is a tool call physically made of, and how does
it survive the trip across three different vendor wire formats without your tools
caring which provider is underneath?

## Structure pass

**Layers.** Three: the *agent* (declares which tools exist, as neutral schemas),
the *runtime loop* (interprets a tool-use block, runs the tool, builds the
tool-result block), and the *provider adapter* (translates neutral ↔ vendor).

**Axis — trust / who can *do* anything?** Trace it: the model layer can *request*
but never *execute* — it has no hands. The runtime layer has the hands: it's the
only place a tool actually runs. The adapter just reshapes bytes; it executes
nothing. So execution authority is concentrated in exactly one layer, and the
model is structurally incapable of acting on its own.

```
  One question — "who can actually execute a tool?"

  ┌─ model (vendor) ─┐   → can only REQUEST (emits tool_use text)
  └──────────────────┘
  ┌─ runtime loop ───┐   → HAS THE HANDS (tools.callTool runs it)
  └──────────────────┘
  ┌─ adapter ────────┐   → translates shapes, executes NOTHING
  └──────────────────┘
```

**Seams.** Two load-bearing seams. (1) The *tool-use/tool-result* seam inside the
loop — where a model request becomes a real function call and its result becomes
the next message. (2) The *adapter* seam — where AptKit's vendor-neutral
`ModelTool` becomes an Anthropic `Tool` or an OpenAI `ChatCompletionTool`. The
trust axis flips across seam 1 (request → execution); the *format* changes across
seam 2 (neutral → vendor). Both matter; they matter for different reasons.

## How it works

You already know a callback: you hand a function a name and arguments, it runs,
you get a result. Tool calling is a callback where the *caller is a language
model* and the call request arrives as structured data in the model's output
instead of as a function invocation. The model says the words "call this"; your
code does the calling.

### Move 1 — the mental model

```
  The tool-call round-trip — three blocks, one loop turn

  model emits ──►  ┌──────────────────────────────┐
                   │ tool_use { id, name, input } │  the REQUEST
                   └──────────────┬───────────────┘
                                  │ your code reads name+input
                                  ▼
                   ┌──────────────────────────────┐
                   │  tools.callTool(name, input) │  the HANDS run it
                   └──────────────┬───────────────┘
                                  │ wrap the return value
                                  ▼
  fed back as ◄──  ┌──────────────────────────────┐
                   │ tool_result { toolUseId,      │  the OBSERVATION
                   │   content }  (id MUST match)  │
                   └──────────────────────────────┘
```

The `id` on the request and the `toolUseId` on the result are the same string —
that's how the model matches "the answer I'm reading now" to "the call I asked
for." Lose the id linkage and the model can't tell which result answers which
request when it fired several at once.

### Move 2 — the three blocks, one at a time

**The request: `ModelToolUseBlock`.** Bridge from a serialized RPC — it's a
`{ id, name, input }` triple the model produces *as part of its response
content*, not as a side effect. `id` is a correlation token. `name` is which tool.
`input` is the arguments object the model filled in to match the schema. Boundary
condition: the model can hallucinate a `name` that isn't in your allowlist or an
`input` that violates the schema — the loop has to handle a tool that throws (see
`06-error-recovery.md`).

```
  ModelToolUseBlock — the model's request shape

  { type: 'tool_use',
    id:    'toolu_01ABC…',          ← correlation token
    name:  'get_metric_timeseries', ← which tool (must be allowed)
    input: { metric: 'revenue',     ← args the model filled from the schema
             window: '7d' } }
```

**The execution: `tools.callTool`.** Bridge from a router — the loop pulls the
`name`, looks up the handler in the registry, and invokes it with `input`. This
is the *only* place anything actually runs. It runs inside a try/catch so a
throwing tool becomes a recoverable observation, and it times the call for the
trace. Boundary condition: a tool that hangs has no per-tool timeout in AptKit —
it can stall the whole turn (named gap; see `06-error-recovery.md`).

```
  Layers-and-hops — request to execution and back

  ┌─ model (vendor) ─┐ hop1: tool_use{id,name,input}  ┌─ runtime loop ─┐
  │  brain           │ ──────────────────────────────►│  hands         │
  └──────────────────┘ hop4: tool_result{toolUseId} ◄─└───────┬────────┘
                                                       hop2 │ callTool(name,input)
                                                            ▼
                                                    ┌─ ToolRegistry ─┐
                                                    │  run handler   │
                                                    └───────┬────────┘
                                                       hop3 │ return value
                                                            ▼ (JSON.stringify, truncate 16k)
```

**The observation: `ModelToolResultBlock`.** Bridge from returning a value — the
tool's return value is JSON-stringified, truncated to 16k chars, and wrapped in a
`{ toolUseId, content, isError? }` block. That block is appended to `messages` as
the *next user turn* — that's literally how the model "sees" what its call
returned. Boundary condition: if the tool threw, `isError: true` is set and the
content is `{ error: message }` — the model reads the error and can try a different
approach instead of crashing the run.

### Move 2.5 — the adapter seam: vendor-neutral by design

Here's the part that earns its keep operationally. AptKit's tools never mention
Anthropic or OpenAI. A tool is a `ModelTool { name, description, inputSchema }` —
a neutral struct. At the provider boundary, an adapter translates it into the
vendor's shape, and translates the model's tool-call output back into neutral
blocks.

```
  Comparison — one neutral tool, two vendor shapes

  ModelTool (neutral)            Anthropic Tool          OpenAI ChatCompletionTool
  ─────────────────────          ────────────────        ──────────────────────────
  name:        'get_…'      ──►  name:        'get_…'  ┌► function.name: 'get_…'
  description: '…'          ──►  description: '…'      │  function.description: '…'
  inputSchema: {…}          ──►  input_schema: {…}     └► function.parameters: {…}

  same tool — only the FIELD NAMES change at the seam
```

The payoff: you write a tool once, and swapping the provider (or running the
fallback chain) changes nothing about your tools. The vendor difference is
quarantined to two small translator functions. This is the same reason the agent
loop is provider-agnostic — the `ModelProvider` interface and the neutral block
types are the contract; vendors live behind it.

### Move 3 — the principle

The model proposes, the code disposes. Keep the model structurally unable to
*do* anything — it can only emit a request — and keep execution in one place you
control. Then make the tool contract vendor-neutral so the "which model" decision
never leaks into "what my tools look like." Brain and hands stay separate; the
vendor stays behind an adapter. That separation is what makes the system both
safe (the model can't reach past its allowlist) and portable (swap providers
freely).

## Primary diagram

The full round-trip, every block and every layer labelled.

```
  Tool calling — full picture across the stack

  AGENT: toolSchemas: ModelTool[] = filterToolsForPolicy(allTools, policy)
        │
        ▼ passed to runAgentLoop
  ┌─ RUNTIME (run-agent-loop.ts) ──────────────────────────────────────┐
  │ model.complete({ system, messages, tools: toolSchemas })           │
  │       │                                                            │
  │       ▼ response.content contains…                                 │
  │  ModelToolUseBlock { id, name, input }   ← the REQUEST              │
  │       │  toolUsesFromContent()                                     │
  │       ▼                                                            │
  │  tools.callTool(name, input)  ← THE HANDS (only execution point)   │
  │       │  try → result | catch → { error }                          │
  │       ▼  JSON.stringify, truncate(16k)                             │
  │  ModelToolResultBlock { toolUseId, content, isError? }             │
  │       │  appended as next user message → OBSERVATION                │
  │       └──────────────────► loop                                    │
  └────────────────────────────┬───────────────────────────────────────┘
                               │ ModelProvider.complete()
  ┌─ PROVIDER ADAPTER ─────────▼───────────────────────────────────────┐
  │  toAnthropicTool / toOpenAITool — neutral → vendor on the way in   │
  │  vendor tool-call output → ModelToolUseBlock on the way out         │
  └──────────────────────────────────────────────────────────────────┘
```

## Implementation in codebase

**Use cases.** Every agent declares its tools as neutral `ModelTool[]` and never
touches a vendor shape. The recommendation agent hands the model 13 read-only
discovery tools; the query agent hands it ~49; the anomaly monitor hands it 4.
The loop runs whichever the model requests, against whichever provider is wired
in — Anthropic in prod, a fixture in tests — with no code change to the tools.

**The neutral block types**, `packages/runtime/src/model-provider.ts:6-31`:

```
  packages/runtime/src/model-provider.ts  (lines 6-18, 27-31)

  type ModelToolUseBlock = {
    type: 'tool_use';
    id: string;                 ← correlation token (matches the result)
    name: string;               ← which tool the model wants
    input: Record<string,unknown>;  ← args, shaped to the schema
  };
  type ModelToolResultBlock = {
    type: 'tool_result';
    toolUseId: string;          ← MUST equal the request id
    content: string;            ← stringified tool output
    isError?: boolean;          ← set when the tool threw
  };
  type ModelTool = {            ← the SCHEMA the model sees
    name: string; description?: string; inputSchema: object;
  };
       │
       └─ these three are vendor-neutral. No 'anthropic' or 'openai'
          field anywhere — that's the whole point of the layer.
```

**The execution + observation**, `packages/runtime/src/run-agent-loop.ts:139-189`:

```
  packages/runtime/src/run-agent-loop.ts  (lines 158-186)

  try {
    const { result, durationMs } =
      await tools.callTool(toolUse.name, toolUse.input, { signal }); ← HANDS run it
    resultContent = truncate(JSON.stringify(result));                ← 16k cap
  } catch (error) {
    isError = true;
    resultContent = truncate(JSON.stringify({ error: message }));    ← error → observation
  }
  …
  toolResults.push({
    type: 'tool_result',
    toolUseId: toolUse.id,            ← link back to the request id
    content: resultContent,
    ...(isError ? { isError: true } : {}),
  });
       │
       └─ callTool is the single execution point; the result (or error)
          is wrapped and fed back as the model's next observation. The
          model never ran anything — your code did.
```

**The adapter seam**, the neutral→vendor translators:

```
  packages/providers/anthropic/src/anthropic-provider.ts  (lines 89-93)

  function toAnthropicTool(tool: ModelTool): Anthropic.Messages.Tool {
    return { name: tool.name, description: tool.description,
             input_schema: tool.inputSchema };   ← inputSchema → input_schema
  }

  packages/providers/openai/src/openai-provider.ts  (lines 127-133)

  function toOpenAITool(tool: ModelTool): ChatCompletionTool {
    return { type: 'function', function: {
      name: tool.name, description: tool.description,
      parameters: tool.inputSchema };            ← inputSchema → function.parameters
  }
       │
       └─ same neutral ModelTool, two field renamings. Swap providers and
          your tool definitions don't change one character.
```

## Elaborate

Function calling shipped as a first-class API feature in mid-2023 (OpenAI), and
the pattern is now universal — every major provider exposes a "here are tools the
model may request; I'll tell you which it picked" loop. The deep idea, older than
LLMs, is the *capability* model: a component that can only *request* an action
through a mediator, never perform it directly, is far easier to sandbox than one
with ambient authority. The model is that component; `callTool` is the mediator.

The vendor-neutral block types are AptKit's deliberate seam. Without them, every
agent would import the Anthropic SDK types and you couldn't run the fallback chain
or test against a fixture without rewriting tools. The cost is two small adapter
functions per provider; the payoff is that "which model" is a config decision, not
an architecture decision.

Adjacent concepts: the loop that drives these calls (`03-react-pattern.md`), which
tools a given agent is even *allowed* to request (`04-tool-routing.md`), and what
happens when a tool throws or the model hallucinates a call (`06-error-recovery.md`).

## Project exercises

*Provenance: Phase 4 — Agents and tool use (C4.x). No `aieng-curriculum.md`
present; IDs are by-phase convention. Case A — tool calling is implemented;
these harden the seams.*

### Exercise — reject hallucinated tool names at the seam

- **Exercise ID:** `[A4.3]` Phase 4, tool-calling concept
- **What to build:** In `runAgentLoop`, before `callTool`, check `toolUse.name`
  against the set of `toolSchemas` names. If the model requests a tool that
  wasn't offered, return a structured `{ error: 'unknown tool: X' }` observation
  instead of letting the registry throw a generic "tool not found."
- **Why it earns its place:** A hallucinated tool name is a real, common failure;
  a precise observation lets the model self-correct. Tightens the request seam.
- **Files to touch:** `packages/runtime/src/run-agent-loop.ts`,
  `packages/runtime/test/run-agent-loop.test.ts`.
- **Done when:** A fixture that requests an off-allowlist tool produces the precise
  error observation and the model gets a chance to retry; a test proves it.
- **Estimated effort:** `1–4hr`

### Exercise — assert adapter round-trip equivalence

- **Exercise ID:** `[A4.4]` Phase 4, vendor-neutral tools
- **What to build:** A test that takes one `ModelTool`, runs it through
  `toAnthropicTool` and `toOpenAITool`, and asserts the `name`/`description`/schema
  survive the renaming intact for both vendors.
- **Why it earns its place:** The whole portability claim rests on the adapter
  preserving the tool faithfully. A test pins that contract so a future SDK bump
  can't silently break it.
- **Files to touch:**
  `packages/providers/anthropic/test/anthropic-provider.test.ts`,
  `packages/providers/openai/test/openai-provider.test.ts`.
- **Done when:** Both tests assert field-for-field equivalence of the schema after
  translation.
- **Estimated effort:** `<1hr`

## Interview defense

**Q: Can the model call your tools directly?**
"No — and that's the whole design. I'd draw the split:"

```
  model (brain)        runtime (hands)
  emits tool_use ────► tools.callTool runs it ────► tool_result back
  can REQUEST           the ONLY place anything executes
```

"The model can only emit a `tool_use` block — a `{ id, name, input }` triple in
its text output. My loop reads that, runs the actual function in `callTool`, and
feeds the result back as a `tool_result`. The model never touches my API. That's
`run-agent-loop.ts:158`, and it's why a hijacked model still can't *do* anything
outside what my code chooses to execute."
*Anchor: the model proposes, the code disposes — execution lives in one place.*

**Q: You support Anthropic and OpenAI. How much of your tool code is
provider-specific?**
"Almost none. My tools are neutral `ModelTool { name, description, inputSchema }`.
The only provider-specific code is two translator functions — `toAnthropicTool`
renames `inputSchema` to `input_schema`, `toOpenAITool` nests it under
`function.parameters`. Swapping providers changes those two functions, not a
single tool. That's `anthropic-provider.ts:89` and `openai-provider.ts:127`."
*Anchor: the vendor difference is quarantined to the adapter seam.*

## Validate

- **Reconstruct:** From memory, draw the three blocks of a tool round-trip
  (`tool_use` → `callTool` → `tool_result`) and name what links the request to
  the result. Check against `model-provider.ts:6-18`.
- **Explain:** Why is the tool's return value `JSON.stringify`-ed and truncated to
  16k before becoming a `tool_result` (`run-agent-loop.ts:162`)? (It must be text
  in the `content` field, and an unbounded result could blow the context window.)
- **Apply:** The model emits a `tool_use` for a tool name that isn't in the
  allowlist. What happens today? (`callTool` throws "tool not found"; the catch
  turns it into an `{ error }` observation — `run-agent-loop.ts:163` — and the
  model can try again. Exercise `[A4.3]` makes that error precise.)
- **Defend:** Why keep `ModelTool` vendor-neutral instead of importing the
  Anthropic `Tool` type directly? (So tools, the loop, and tests don't depend on
  any vendor; the difference lives only in `toAnthropicTool`/`toOpenAITool`.)

## See also

- [03-react-pattern.md](03-react-pattern.md) — the loop that drives tool calls
- [04-tool-routing.md](04-tool-routing.md) — which tools an agent may request
- [06-error-recovery.md](06-error-recovery.md) — when a tool throws or is hallucinated
- [../01-llm-foundations/04-structured-outputs.md](../01-llm-foundations/04-structured-outputs.md) — the schema discipline tool inputs share
- [../06-production-serving/03-prompt-injection.md](../06-production-serving/03-prompt-injection.md) — why the brain/hands split is a security boundary
