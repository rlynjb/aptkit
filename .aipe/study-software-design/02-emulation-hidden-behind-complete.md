# 02 — Emulation Hidden Behind `complete()`

**Subtitle:** Information hiding · capability emulation behind a uniform
interface — *Project-specific* (Gemma can't do tool-calling; aptkit fakes it so
no caller ever finds out).

---

## Zoom out, then zoom in

`01-deep-provider-module.md` showed five bodies behind one `complete()` seam.
This file zooms into the deepest, weirdest one. Gemma (via Ollama) has **no
native tool-calling** — you cannot hand it a `tools` array and get back a
structured tool call the way Anthropic's API does. But the agent loop *requires*
that behaviour. So the Gemma provider manufactures it.

```
  Zoom out — the hidden complexity lives in one adapter body

  ┌─ Runtime / agents ───────────────────────────────────────────┐
  │  assume EVERY provider can take tools and return tool_use      │
  └────────────────────────────┬───────────────────────────────────┘
                               │ complete({ messages, tools })
  ┌─ Provider seam ────────────▼───────────────────────────────────┐
  │  ModelProvider.complete()  — same contract for all              │
  └────────────────────────────┬───────────────────────────────────┘
                               │
  ┌─ Gemma body (★ here) ──────▼───────────────────────────────────┐
  │  Gemma has no tools API. So: render tools into system prose →   │
  │  ask for JSON → salvage the JSON → retry if botched → hand back │
  │  a tool_use block as if it were native.                         │
  └──────────────────────────────────────────────────────────────────┘
```

Zoom in: the concept is **information hiding** — Ousterhout's idea that a
module's job is to *encapsulate a design decision* so it doesn't leak. The
decision being hidden here is enormous: "this model doesn't actually support the
thing the whole system depends on." That fact is contained entirely inside one
file. Callers see a normal `tool_use` block come back and never learn it was
forged.

---

## Structure pass

- **Layers:** the public `complete()` → the outbound half (`buildSystemText`)
  → the model round-trip → the inbound half (`parseToolCall`) → the retry loop.
- **Axis — "where does the 'Gemma can't do tools' fact live?":** trace it.
  - caller → doesn't exist for the caller. It sends `tools` and gets `tool_use`
    back. Fact is invisible.
  - `complete()` signature → invisible. Same signature as every provider.
  - *inside* `complete()` → **this is the only place the fact lives.** The
    branch `wantsTool = Boolean(request.tools?.length)` (`gemma-provider.ts:56`)
    is where the system admits Gemma is different.
- **Seam:** the function body boundary. The "weakness" is sealed inside; nothing
  above it changes. That containment *is* the design.

---

## How it works

### Move 1 — the mental model

Think of a polyfill. `Array.prototype.flat` didn't exist in older runtimes, so a
polyfill implemented it in plain JS and installed it under the same name —
calling code couldn't tell. The Gemma provider is a tool-calling polyfill: it
implements, in prompt + parsing, a capability the model lacks, and exposes it
under the same `complete()` name.

```
  Pattern — the emulation round-trip (the kernel)

   request.tools ─┐
                  ▼
        buildSystemText: tools → JSON-in-system-prose  (outbound half)
                  │
                  ▼   POST /api/chat  (the model only ever sees text)
        Gemma returns messy text
                  │
                  ▼
        parseToolCall: salvage {tool, arguments} from text  (inbound half)
                  │
            ┌─────┴─────┐
         got a call?   no, but it looked like one ("{")?
            │             │
            ▼             ▼
       return tool_use   RETRY_NUDGE, loop (≤ maxToolCallAttempts)
       block (forged)    then give up → return as plain text
```

The strategy: **never tell the model it's emulating. Translate tools→prose on
the way in, prose→tool_use on the way out, and retry the round-trip when the
salvage fails.**

### Move 2 — the step-by-step walkthrough

**Outbound half — tools become system prose.** Gemma can't take a `tools` array,
so `buildSystemText` serializes each tool's schema into the system message and
demands a specific JSON reply shape.

```ts
// packages/providers/gemma/src/gemma-provider.ts:133-165 (condensed)
function buildSystemText(request: ModelRequest): string {
  const parts: string[] = [];
  if (request.system) parts.push(request.system);
  if (request.tools?.length) {
    const rendered = request.tools.map((tool) =>
      JSON.stringify({ name: tool.name, description: tool.description ?? '',
                       input_schema: tool.inputSchema }, null, 2)).join('\n\n');
    parts.push([
      'You can call the following tools:', '', rendered, '',
      'When a tool is needed, respond with ONLY a single JSON object, no prose:',
      '{"tool": "<tool name>", "arguments": { ...arguments... }}',
      'Otherwise, answer the user directly in natural language.',
    ].join('\n'));
  }
  return parts.join('\n\n');
}
```

The exact wire format Anthropic exposes as a first-class API parameter, aptkit
recreates as instructions inside a string. The caller passed `tools`; this
function is where `tools` quietly becomes prose.

**Inbound half — messy text becomes a tool call.** Gemma will wrap the JSON in
markdown fences, add a preamble, use `name` instead of `tool` — so the parse is
*tolerant*, not strict.

```ts
// gemma-provider.ts:168-182 (condensed)
function parseToolCall(text: string) {
  let parsed;
  try { parsed = parseAgentJson(text); } catch { return null; }   // salvage JSON
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
  const obj = parsed as Record<string, unknown>;
  const name  = obj.tool ?? obj.name ?? obj.tool_name;   // accept 3 spellings
  const input = obj.arguments ?? obj.input ?? obj.args;  // accept 3 spellings
  if (typeof name !== 'string') return null;
  if (!input || typeof input !== 'object' || Array.isArray(input)) return null;
  return { name, input: input as Record<string, unknown> };
}
```

`parseAgentJson` (from the runtime) does the fence-stripping; `parseToolCall`
then accepts any of the spellings a weak model might emit. The tolerance is the
hidden complexity — and it's correct to hide it, because *every* caller would
otherwise need to know Gemma's quirks.

**The retry loop — the load-bearing skeleton part.** This is the piece people
forget when they describe emulation, and naming it is the signal you built it.

```ts
// gemma-provider.ts:62-91 (condensed)
for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
  const messages = attempt === 0
    ? baseMessages
    : [...baseMessages, { role: 'user', content: RETRY_NUDGE }];  // corrective nudge
  lastResponse = await this.chat({ model, messages, stream: false, ...signal });
  raw = lastResponse.message?.content ?? '';
  if (wantsTool) {
    const call = parseToolCall(raw);
    if (call) return this.toResponse([{ type:'tool_use', id, name:call.name, input:call.input }], lastResponse);
    if (looksLikeToolAttempt(raw)) continue;  // botched JSON → retry
  }
  break;                                       // plain prose → real answer, stop
}
return this.toResponse([{ type: 'text', text: raw }], lastResponse);  // gave up → text
```

**What breaks if you remove each part:**

- Remove the retry loop → one malformed JSON reply and the tool call is lost; the
  agent gets prose where it expected structure and the whole turn fails. The loop
  is what makes emulation *reliable* enough to depend on.
- Remove `looksLikeToolAttempt` (the `'{'` heuristic, line 185-187) → you can't
  tell "Gemma tried to call a tool and botched the JSON" from "Gemma answered in
  prose, which is a valid response." You'd either retry valid prose answers
  forever or never retry botched calls. This one cheap heuristic separates the
  two cases.
- Remove `RETRY_NUDGE` → the retry sends the same prompt and gets the same bad
  output. The corrective nudge is what makes the retry *do* something.

**Skeleton vs hardening:** the kernel is `buildSystemText` + `parseToolCall` +
the single round-trip. The retry loop, the nudge, and the
botched-vs-prose heuristic are *hardening* — they make the kernel survive a weak
model. Saying which is which is the lesson: you could ship the kernel alone for a
strong local model; you need the hardening for Gemma specifically.

### Move 3 — the principle

Information hiding isn't about pretty code — it's about *which fact must not
escape*. Here the fact is "the model lacks a core capability," and the value of
hiding it is concrete and measurable: the agent loop, every agent, and every test
are written against native tool-calling and **zero of them change** when the
backend is a model that can't do it. The complexity didn't disappear; it got
sealed in one file where it's paid for once.

---

## Primary diagram

```
  Emulation hidden behind complete() — full picture

  caller: complete({ messages, tools })           ← sees a normal provider
    │
  ══▼═══════════════════ Gemma body (the only place the secret lives) ════
    │
    ├─ buildSystemText ──► tools rendered as JSON inside system prose
    │                      "respond with ONLY {tool, arguments}"
    │
    ├─ attempt loop (≤ maxToolCallAttempts, default 2) ──────────────┐
    │     POST /api/chat (stream:false) → raw text                    │
    │     parseToolCall(raw): strip fences, accept tool|name|tool_name│
    │       ├ got call → return [{type:'tool_use', ...}]  ◄───────────┤ forged
    │       └ looksLikeToolAttempt('{')? → append RETRY_NUDGE, retry ─┘
    │
    └─ no call after retries → return [{type:'text', text: raw}]
  ════════════════════════════════════════════════════════════════════════
    │
  caller receives: ModelResponse with a tool_use block — identical to native
```

---

## Elaborate

This is the same problem every "local model" wrapper hits: open-weight models
served by Ollama rarely match the hosted APIs' structured-output guarantees, so
you bridge the gap in the adapter. The alternative — letting agents know "if
provider is Gemma, prompt differently and parse JSON yourself" — would scatter
Gemma's quirks across every agent and every test. Containing it in one
`complete()` body is the difference between a swappable provider and a special
case that infects the codebase.

The honest cost: this body is the single hardest file to read in the repo
(`audit.md` lens 1). That's acceptable *because* the difficulty is contained —
the cost is paid once by whoever maintains this adapter, never by a caller. If
the difficulty leaked upward, it'd be a different verdict.

Adjacent: `01-deep-provider-module.md` (the seam this hides behind);
`../study-prompt-engineering/` if present (the system-prose tool rendering is a
prompt-engineering technique); `../study-testing/` (the `chat` transport is
injectable precisely so this emulation is testable without Ollama —
`05-injectable-trace-seam.md` is the same seam idea).

---

## Interview defense

**Q: Walk me through how a model with no tool-calling participates in a tool-using
agent loop.**

The provider emulates it. Outbound, it renders the tool schemas into the system
prompt and demands a strict JSON reply. The model returns text. Inbound, the
provider salvages a `{tool, arguments}` object from that text — tolerantly,
because weak models add fences and vary the key names — and repackages it as a
native `tool_use` block. If the JSON is botched but *looks* like an attempt, it
retries with a corrective nudge, up to a bound.

```
  tools ──► system prose ──► [model: text] ──► salvage JSON ──► tool_use
                                  └─ botched? RETRY_NUDGE, ≤2 attempts
```

**Q: What's the load-bearing part people forget?**

The botched-vs-prose discrimination. A `'{'` in the output is the cheap tell
that the model *tried* a tool call and failed — versus genuinely answering in
prose, which is a valid terminal response. Without that distinction you can't
decide whether to retry, and you'd either loop on valid answers or drop botched
calls.

*Anchor:* "It's a tool-calling polyfill. Translate tools→prose in, prose→tool_use
out, retry the round-trip on a botched-but-attempted reply — and the entire fact
that the model can't do tools never leaves the `complete()` body."

---

## See also

- `01-deep-provider-module.md` — the contract this body satisfies.
- `04-guard-rails-as-information-hiding.md` — the *tool* side hides the same kind
  of model weakness (hallucinated filters); this is the *provider* side.
- `05-injectable-trace-seam.md` — the injectable `chat` transport that makes this
  testable.
- `audit.md` — lens 1 (cognitive-load hotspot), lens 6 (errors defined out).
