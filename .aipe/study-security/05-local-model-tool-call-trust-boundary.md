# Local-model tool-call trust boundary

*No-auth local inference + model-driven tool-call emulation · LLM-agent security · Project-specific*

## Zoom out, then zoom in

The cloud providers had a clean trust story: a keyed HTTPS call leaves your
machine, untrusted text comes back, you gate the text. Gemma changes the
shape on *both* ends. The model now runs as a separate process on your own
machine over **plain HTTP localhost, no API key, no TLS** — and because
Ollama's `gemma2:9b` has no native tool-calling, AptKit *emulates* it: it
renders the tool schemas into system text, asks the model to reply with a
JSON object, and **parses that JSON back into a tool invocation**. The model
now controls tool dispatch by emitting a name string. That's a sharper trust
boundary than anything the keyed providers had.

```
  Zoom out — where the Gemma boundary sits

  ┌─ Capability layer (rag-query agent) ───────────────────────────┐
  │  RagQueryAgent — allowlist: [search_knowledge_base] only       │
  └────────────────────────────┬────────────────────────────────────┘
                               │  toolSchemas (filtered)
  ┌─ Runtime layer (runAgentLoop) ────────▼───────────────────────┐
  │  sends schemas, runs tools.callTool(name) on tool_use          │
  └────────────────────────────┬────────────────────────────────────┘
                               │  request {system, messages, tools}
  ┌─ Provider layer ───────────▼──────── ★ GemmaModelProvider ★ ───┐
  │  renders tools INTO system text  →  parseToolCall(model text)  │ ← here
  │  plain HTTP, no key, no TLS                                    │
  └────────────────────────────┬────────────────────────────────────┘
                               │  POST http://localhost:11434/api/chat
  ┌─ Local Ollama process (SEPARATE TRUST DOMAIN) ─────────────────┐
  │  gemma2:9b — emits the JSON that becomes a tool call           │
  └─────────────────────────────────────────────────────────────────┘
```

The pattern: **the model's free-text output is parsed into a control
decision (which tool to call, with what arguments).** With the cloud SDKs the
provider emitted structured `tool_use` blocks; here AptKit reconstructs them
from prose. The seam where prose becomes control is the thing to study.

## Structure pass

**Layers** (top to bottom): capability declares the allowlist → runtime
sends schemas and dispatches by name → Gemma provider renders tools out and
parses tool calls back in → a local Ollama process emits the JSON.

**Axis — trust:** *what does each hop assume about the side it talks to?*
Trace it down:

```
  One question down the layers: "what's trusted across this hop?"

  capability → runtime : the allowlist is honest        (in-process, TRUSTED)
  runtime    → provider: the request is well-formed       (in-process, TRUSTED)
  provider   → Ollama  : localhost:11434 is OUR Ollama   (NETWORK, no auth)
  Ollama     → provider: the text is a tool call          (MODEL output, UNTRUSTED)
```

**Two seams flip the axis, not one:**

1. **The transport seam (provider → Ollama).** A network hop with **no
   authentication and no transport encryption** — the provider trusts that
   whatever answers `http://localhost:11434/api/chat` is the intended model.
   The keyed cloud providers authenticated the *server* (TLS + API key);
   this one authenticates nothing.
2. **The emulation seam (Ollama → provider).** The model's free text is
   parsed by `parseToolCall` into `{name, input}` and dispatched. The model
   *names the tool*. With native tool-calling the provider SDK produced that
   structure; here a hostile or confused model controls it directly through
   prose.

Both seams are new with Gemma. The cloud path had neither: TLS+key closed the
first, native `tool_use` blocks closed the second.

## How it works

### Move 1 — the mental model

You know how a webhook receiver trusts a payload only after it verifies an
HMAC signature? The Gemma path is the *opposite* setup: an unsigned,
unauthenticated local endpoint whose response body is then *interpreted as a
command*. Two assumptions stack — "this is my Ollama" and "this JSON is a
legitimate tool call" — and neither is verified by a cryptographic check. The
defenses are structural, not cryptographic: a tiny allowlist, a bounded loop,
and a parser that fails closed.

```
  The shape — prose becomes a control decision

  model text  ──parseAgentJson──►  { tool, arguments }  ──callTool──► run
      │                                   │
      │  "{"tool":"search_knowledge_base",│  the model NAMED the tool
      │    "arguments":{"query":"..."}}"  │  and shaped the arguments
      └─ free-form, UNTRUSTED ────────────┘
         a parser, not a schema-validated SDK block, is the gate
```

### Move 2 — the walkthrough

**Render tools out as text.** Because Ollama's chat API takes no `tools`
array, the provider serializes each tool's `{name, description, input_schema}`
into the system message and instructs the model to reply with *only* a JSON
object `{"tool": ..., "arguments": ...}`. The model now sees the tool catalog
as prose. Bridge from what you know: this is the same allowlist filtering as
the cloud path (the schemas were already reduced by `filterToolsForPolicy`),
just delivered as text instead of a structured field. The allowlist still
holds — the model is only *shown* `search_knowledge_base`.

```
  Layers-and-hops — outbound tool rendering

  ┌─ provider ──────────┐  hop 1: schemas → system text  ┌─ Ollama ────┐
  │ buildSystemText     │ ─────────────────────────────► │ gemma2:9b   │
  │ (tools as JSON)     │  hop 2: model reply (prose) ◄── │ free text   │
  └─────────────────────┘                                └─────────────┘
```

**Parse the reply back into a tool call — fail closed.** `parseToolCall`
runs the model's text through `parseAgentJson` (the same fence-and-substring
extractor the output gate uses), then checks the result is an object with a
string `tool` and an object `arguments`. Any of those checks failing returns
`null` — *no tool call*, and the loop treats the text as a final answer. The
boundary condition that matters: **a malformed or hostile reply degrades to
"plain answer," it never throws an unvalidated structure at `callTool`.** The
parser is the gate.

```
  pseudocode — parseToolCall(model_text)

  try parsed = parseAgentJson(model_text)       // fence/substring JSON scan
  catch: return null                            // not parseable → no call
  if parsed is not a plain object: return null  // arrays/scalars rejected
  name = parsed.tool ?? parsed.name ?? parsed.tool_name
  input = parsed.arguments ?? parsed.input ?? parsed.args
  if name is not a string: return null          // must name a tool
  if input is not a plain object: return null   // must carry an arg object
  return { name, input }                         // ONLY now is it a tool call
```

**What the parser does NOT do — and why it's still safe here.** It does
**not** check that `name` is on the allowlist. A model that emitted
`{"tool":"save_judgment",...}` would produce a valid `{name,input}` and the
loop would call `tools.callTool("save_judgment")`. This is the *same*
enforcement-by-omission seam as `01-tool-policy-enforcement-by-omission.md`,
reached from a different direction: the rag-query registry only holds the
`search_knowledge_base` handler, so an off-policy name hits "tool not found"
and throws — but that's the *registry's* contents saving you, not a policy
re-check. If that registry ever also held a mutating tool, the by-omission
gap would be live on the Gemma path too.

**The transport assumes localhost is benign.** `defaultHttpTransport` POSTs
to `http://${host}/api/chat` with no `Authorization` header and no TLS. The
trust assumption is "port 11434 on this box is my Ollama and nothing else can
read or answer it." On a single-dev laptop that holds. It stops holding the
moment Gemma runs on a shared host, a container with a published port, or a
`host` pointed at a non-loopback address — then an unauthenticated plaintext
channel is carrying your prompts (which may contain injected `me.md` profile
data) and returning attacker-controllable "tool calls."

```
  Comparison — cloud provider vs Gemma, along the trust axis

  ┌──────────────────────┬───────────────────────┬────────────────────────┐
  │                      │  Anthropic / OpenAI   │  Gemma (Ollama)        │
  ├──────────────────────┼───────────────────────┼────────────────────────┤
  │ transport            │  HTTPS (TLS)          │  plain HTTP            │
  │ server auth          │  API key + TLS cert   │  NONE                  │
  │ tool-call source     │  SDK tool_use block   │  parsed from prose     │
  │ key exposure risk    │  key in .env          │  no key at all         │
  │ trust on the wire    │  provider authn'd     │  "localhost is mine"   │
  └──────────────────────┴───────────────────────┴────────────────────────┘
```

### Move 2 variant — the load-bearing skeleton

Strip the Gemma tool-call boundary to its kernel and name each part by what
breaks without it:

- **The allowlist-as-text rendering.** Remove it and the model is shown
  every registered tool — least-privilege is gone on the local path. This is
  the *omission* gate, same as the cloud path, just serialized differently.
- **`parseToolCall`'s fail-closed checks.** Remove the type guards and a
  scalar, an array, or a missing `arguments` would flow toward `callTool` as
  a malformed dispatch. Failing closed to "plain answer" is what keeps
  garbage out of the executor.
- **The bounded loop + tiny registry.** `maxTurns: 6`, `maxToolCalls: 4`,
  and a registry holding *only* `search_knowledge_base`. Remove the small
  registry and the by-omission gap is exposed; remove the bounds and a model
  stuck emitting tool calls loops without a cost ceiling.

**Optional hardening that isn't here:** (1) an `Authorization` token or a
hard loopback-only bind on the transport, so a non-loopback `host` can't
silently turn the channel into an open network service; (2) an allowlist
re-check inside `callTool` so the emulation seam is defense-in-depth, not
registry-contents-by-luck.

### Move 2.5 — current state vs future state

Today the boundary is safe *because the deployment is a single dev laptop and
the rag-query registry holds one read-only tool.* Both are load-bearing
assumptions, not enforced invariants.

```
  Phase A (now)                      Phase B (shared host / richer registry)
  ───────────────────────            ──────────────────────────────────────
  host = localhost (loopback)        host could be a non-loopback address
  registry = {search_knowledge_base} registry might hold mutating tools
  → plaintext channel is private     → plaintext prompts cross the network
  → off-policy name → "not found"    → off-policy name → it RUNS (by omission)
```

What *doesn't* have to change to harden it: the parser, the allowlist data,
and the loop bounds all stay. You add a transport auth/bind check and a
policy re-check in the executor. The teaching model is unchanged; two gates
get added behind the existing ones.

### Move 3 — the principle

Local inference looks safer than a cloud call — no key to leak, nothing
leaves the box. But it *moves* the trust problem rather than removing it: you
trade a key-confidentiality risk for an **unauthenticated transport** risk
and a **prose-to-control parsing** risk. The principle to carry: *when you
remove a cryptographic boundary (TLS, API key, native structured tool-calls),
you don't remove the trust decision — you relocate it into your own parsing
and deployment assumptions, where it's easy to forget it exists.*

## Primary diagram

The whole boundary, one frame:

```
  Gemma local-model tool-call boundary — end to end

  ┌─ Capability (rag-query) ─────────────────────────────────────┐
  │  ragQueryToolPolicy.allowedTools = [search_knowledge_base]    │
  └────────────────────────────┬──────────────────────────────────┘
                               │ filterToolsForPolicy
  ┌─ Runtime (runAgentLoop) ───▼──────────────────────────────────┐
  │  toolSchemas → model.complete({tools})                        │
  │  on tool_use: tools.callTool(name)  ── omission gate only ──┐  │
  └─────────────────────────────────────────────────────────────┼──┘
                               │ request                         │
  ┌─ GemmaModelProvider ───────▼──────────────────────────────┐  │
  │  buildSystemText: tools → system prose                    │  │
  │  parseToolCall: prose → {name,input} | null (fail closed) │  │
  └────────────────────────────┬──────────────────────────────┘  │
            POST http://localhost:11434/api/chat (NO key, NO TLS) │
  ┌─ Ollama / gemma2:9b ───────▼──────────────────────────────┐  │
  │  emits the JSON that becomes the tool call                │──┘
  └────────────────────────────────────────────────────────────┘ off-policy name
                                                                  → "tool not found"
                                                                  (registry contents,
                                                                   not a policy check)
```

## Implementation in codebase

**Use cases.** The Gemma provider is reached for whenever you want fully local,
key-free inference — the `rag-query` agent is its first consumer, answering
questions grounded in a locally indexed knowledge base over a local embedding
model (`nomic-embed-text`, also via Ollama). It's published: `provider-gemma`,
`retrieval`, and `agent-rag-query` are all in `core`'s `bundledDependencies`
(`packages/core/package.json:35,41,43`), so this whole local-RAG path ships in
the public tarball.

**The emulation seam — render out, parse back in:**

```
  packages/providers/gemma/src/gemma-provider.ts  (133-165, buildSystemText)

  if (request.tools?.length) {
    const rendered = request.tools.map((tool) =>
      JSON.stringify({ name, description, input_schema: tool.inputSchema }))
    parts.push('You can call the following tools:', rendered,
      'respond with ONLY a single JSON object: {"tool":...,"arguments":...}')
        │
        └─ the allowlist already filtered request.tools upstream; this just
           serializes the granted schemas into prose for a model with no
           native tool field
```

```
  packages/providers/gemma/src/gemma-provider.ts  (168-182, parseToolCall)

  try { parsed = parseAgentJson(text); } catch { return null; }   ← fail closed
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed))
    return null;                                                   ← must be object
  const name = obj.tool ?? obj.name ?? obj.tool_name;
  const input = obj.arguments ?? obj.input ?? obj.args;
  if (typeof name !== 'string') return null;                       ← must name a tool
  if (!input || typeof input !== 'object' || Array.isArray(input))
    return null;                                                   ← must carry args
  return { name, input };
        │
        └─ this is the gate: the model NAMES the tool, but a reply that
           isn't a well-formed {tool,arguments} degrades to a plain answer
           rather than producing a malformed dispatch. It does NOT check the
           allowlist — that's still by-omission (file 01).
```

**The unauthenticated transport:**

```
  packages/providers/gemma/src/gemma-provider.ts  (201-215, defaultHttpTransport)

  const res = await fetch(`${base}/api/chat`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },   ← NO Authorization
    body: JSON.stringify(payload),                      ← prompts in plaintext
  });
        │
        └─ host defaults to 'http://localhost:11434' (line 48): plain HTTP,
           no key, no TLS. Safe on loopback; an open network service the
           moment `host` is a non-loopback address. Same shape in the
           embedding provider (ollama-embedding-provider.ts:60-74).
```

**The registry that currently saves the by-omission gap:**

```
  packages/agents/rag-query/src/rag-query-agent.ts  (15-18)

  export const ragQueryToolPolicy = {
    capabilityId: RAG_QUERY_CAPABILITY_ID,
    allowedTools: [SEARCH_KNOWLEDGE_BASE_TOOL_NAME],   ← exactly one tool
  };
        │
        └─ the registry handed to this agent holds only the search handler,
           so a model-emitted off-policy name throws "tool not found"
           (tool-registry.ts:57-59). That's the registry's contents doing
           the work — not a policy re-check at execution.
```

## Elaborate

This is the same policy/mechanism split as file 01, but it exposes a second
truth: **structured tool-calling in the cloud SDKs was doing security work you
didn't have to think about.** Anthropic and OpenAI return `tool_use` blocks
the SDK validated; the transport was TLS with an authenticated server. Emulate
tool-calling over a local model and you inherit both jobs — you become the
parser *and* the transport-trust decision. AptKit does the parser job well
(fail-closed, same extractor as the output gate) and accepts the transport
assumption knowingly for a dev tool. The buildable move when this leaves the
laptop: bind Ollama to loopback or add a shared token, and pass the active
`ToolPolicy` into `callTool` so the emulation seam is mediated rather than
omission-only. See `01-tool-policy-enforcement-by-omission.md` for the
execution-seam gap this shares, `04-validated-model-output-gate.md` for the
`parseAgentJson` extractor reused here, and
`.aipe/study-system-design/01-provider-abstraction.md` for the provider
boundary as architecture.

## Interview defense

**Q: Gemma runs locally with no API key — isn't that strictly safer than a
cloud provider?**

> No — it relocates the trust problem. You drop the key-leak risk, but you
> pick up an *unauthenticated plaintext transport*
> (`gemma-provider.ts:201`, plain HTTP to `localhost:11434`, no
> `Authorization`, no TLS) and a *prose-to-control* risk: gemma2:9b has no
> native tool-calling, so AptKit renders tools into the system prompt and
> parses the model's text back into a tool call (`parseToolCall`,
> `gemma-provider.ts:168`). The model now controls dispatch through free text.

```
  cloud:  TLS + key + SDK tool_use block   →  two cryptographic gates
  gemma:  plain HTTP + parsed prose        →  a parser + a deployment assumption
```

**Anchor:** removing the key didn't remove the trust decision — it moved it
into my parser and my "localhost is mine" assumption.

**Q: What stops the model from naming a tool it shouldn't?**

> Two things, only one of them deliberate. `parseToolCall` fails closed — a
> reply that isn't a well-formed `{tool, arguments}` becomes a plain answer,
> not a dispatch. But it does *not* check the allowlist. What actually blocks
> an off-policy name today is that the rag-query registry holds only
> `search_knowledge_base`, so anything else throws "tool not found"
> (`tool-registry.ts:57`). That's registry contents, not a policy re-check —
> the same by-omission gap as the cloud path.

```
  parseToolCall → {name,input}  ──► callTool(name) ──► handlers.get(name)
       fail-closed (deliberate)          │                 │
                                         │                 └─ only thing
                                         └─ NO allowlist check  checking
```

**Anchor:** the parser keeps garbage out; only the registry's short menu
keeps the wrong tool out — and that's luck, not a gate.

## Validate

1. **Reconstruct:** from memory, draw both seams on the Gemma path — the
   transport seam and the emulation seam — and name what flips across each
   along the trust axis.
2. **Explain:** why does `parseToolCall` (`gemma-provider.ts:168`) return
   `null` instead of throwing on a malformed reply? What would break in
   `runAgentLoop` if it threw?
3. **Apply:** suppose the rag-query registry were extended to also hold a
   `delete_document` handler but the policy still listed only
   `search_knowledge_base`. On the Gemma path, could a model reach
   `delete_document`? Trace it through `parseToolCall` →
   `run-agent-loop.ts:159` → `tool-registry.ts:57` and name the missing gate.
4. **Defend:** argue whether the no-auth plaintext transport
   (`gemma-provider.ts:201`) is an acceptable tradeoff for a local dev tool,
   and name the single deployment change that would make it unacceptable.

## See also

- `audit.md` → lens 1 (trust boundaries), lens 3 (input validation), lens 7
  (LLM/agent security)
- `01-tool-policy-enforcement-by-omission.md` — the execution-seam gap this
  shares, reached from the cloud path
- `04-validated-model-output-gate.md` — the `parseAgentJson` extractor reused
  by `parseToolCall`
- `.aipe/study-system-design/01-provider-abstraction.md` — the provider
  boundary as architecture
- `.aipe/study-agent-architecture/` — read-only grants as an agent-safety
  property
