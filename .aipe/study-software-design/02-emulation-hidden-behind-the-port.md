# Emulation Hidden Behind the Port

**Industry name(s):** adapter / anti-corruption layer / capability
emulation · **type:** Industry standard (the adapter role) + project-
specific (the emulation it hides)

The deepest adapter in the repo. Gemma has no native tool-calling, so the
adapter (`GemmaModelProvider`) fakes it — rendering tools into text,
parsing the model's reply back into a structured call, and retrying when
the JSON is botched — and hides every bit of that behind the same
three-method port (`ModelProvider`) every other model uses.

---

## Zoom out, then zoom in

Here's the thing the agent loop sees, and the thing it doesn't. The loop
calls `complete()` and gets back content blocks — text or `tool_use` —
exactly as it would from Anthropic. It has no idea that for Gemma, "a
tool call" was reconstructed from a blob of model prose.

```
  Zoom out — the adapter sits between the loop and Ollama

  ┌─ Client layer ────────────────────────────────────────────┐
  │ runAgentLoop — sees only ModelContentBlock[] (text|tool_use)│
  └──────────────────────────┬─────────────────────────────────┘
                             │ complete(request)  [the port]
  ┌─ Adapter layer ★ ────────▼─────────────────────────────────┐
  │ GemmaModelProvider                                          │  ← we are here
  │  buildSystemText → ask for JSON → parseToolCall → retry     │
  └──────────────────────────┬─────────────────────────────────┘
                             │ POST /api/chat  (plain text in/out)
  ┌─ Provider layer (Ollama) ▼─────────────────────────────────┐
  │ gemma2:9b — no tools array, no structured output            │
  └─────────────────────────────────────────────────────────────┘
```

Zoom in: the concept is **information hiding via an adapter** — the
adapter absorbs a vendor's weakness (no tool-calling) so the weakness
never leaks above the port. The question: *how do you put a model that
can't call tools behind the same interface as one that can, without the
agent loop branching on the model?*

---

## The structure pass

**Layers.** Client (the loop) → port (`ModelProvider.complete`) →
adapter (`GemmaModelProvider`) → sub-port (`GemmaChatTransport`) →
Ollama HTTP.

**Axis — trace `guarantees` (structured tool-call: promised or
best-effort?).**

```
  One axis: "is a structured tool call guaranteed?"

  ┌─ above the port ──┐  GUARANTEED — loop gets tool_use blocks
  │ runAgentLoop      │  ═══════════════════════════════╪═══════►
  └───────────────────┘                            (it flips)
  ┌─ below the port ──┐  BEST-EFFORT — Gemma emits text, maybe JSON,
  │ Ollama / gemma2   │  maybe prose; the adapter has to make it true
  └───────────────────┘
```

**Seam.** The port boundary is load-bearing because the `guarantees`
axis flips across it: above it a structured tool call is *promised*;
below it, it's a hope the adapter has to enforce with parse + retry. That
gap is the adapter's whole job.

---

## How it works

### Move 1 — the mental model

You've written a function that takes a flaky third-party response and
normalizes it before the rest of your app touches it — a `try/catch`
around a parse, a default when a field is missing. Gemma's adapter is
that, scaled up to "make a model that can't call tools look like one that
can." One plain sentence: it renders the tools into the system prompt,
demands a specific JSON shape back, and parses that JSON into the same
`tool_use` block a native provider would return.

```
  Pattern — the emulation loop inside complete()

      buildSystemText(tools)  ─► ask Gemma for JSON
                                       │
                                       ▼
                                 parseToolCall(raw)
                                  ┌────┴────┐
                            got a call?   no, but looks
                            └─► return    like an attempt?
                                tool_use   └─► nudge + retry
                                               (up to maxAttempts)
                                       │
                                  plain prose? └─► return as text
```

### Move 2 — the step-by-step walkthrough

**Step 1 — render the tools into text (the outbound half).** A native
provider takes a `tools` array. Gemma can't, so `buildSystemText`
(`gemma-provider.ts:133`) serializes each tool into the system prompt and
appends the instruction:

```ts
'When a tool is needed, respond with ONLY a single JSON object, no prose:',
'{"tool": "<tool name>", "arguments": { ...arguments... }}',
'Otherwise, answer the user directly in natural language.',
```

The model's only channel is text, so the contract is pushed into the
prompt. This is the move that converts "no tool support" into "tool
support, by convention."

**Step 2 — parse the reply back into a structured call (the inbound
half).** `parseToolCall` (`gemma-provider.ts:168`) runs the raw text
through `parseAgentJson`, then tolerantly accepts any of `tool`/`name`/
`tool_name` for the name and `arguments`/`input`/`args` for the payload
(:177–178). Local models are inconsistent about which key they use; the
adapter absorbs that variance so the loop never sees it.

**Step 3 — retry only when it looks botched.** Here's the clever bit and
the non-obvious control flow (`gemma-provider.ts:62–89`):

```ts
if (wantsTool) {
  const call = parseToolCall(raw);
  if (call) return this.toResponse([{ type: 'tool_use', ... }], lastResponse);
  if (looksLikeToolAttempt(raw)) continue;   // a '{' is the cheap tell
}
break;
```

If the parse succeeds → return the `tool_use` block. If it fails *but the
text contains a `{`* (`looksLikeToolAttempt`, :185) → it tried and
botched the JSON, so append `RETRY_NUDGE` (:35) and ask again. If it's
plain prose with no `{` → that's a real natural-language answer; don't
waste a retry. The comment at :85 makes this legible — *"plain prose is a
real answer."* Without that line the skip would read as a bug.

**Step 4 — return the same shape every adapter returns.** `toResponse`
(`gemma-provider.ts:116`) wraps the result in a `ModelResponse` with
`content`, `model`, and `usage` from Ollama's `prompt_eval_count` /
`eval_count`. Whether it ended in a `tool_use` block or a `text` block,
the loop gets the standard shape.

```
  Layers-and-hops — one complete() call, the emulation hidden inside

  ┌─ Client ─────────┐  hop 1: complete({ tools: [...] })
  │ runAgentLoop      │ ─────────────────────────────────┐
  └──────────────────┘                                    ▼
  ┌─ Adapter ────────────────────────────────────────────────────┐
  │ GemmaModelProvider                                            │
  │  hop 2: buildSystemText renders tools → prompt                │
  │  hop 3: POST /api/chat (text) ──► hop 4: raw text back        │
  │  hop 5: parseToolCall → tool_use?  no+'{' → nudge, loop hop 3 │
  └──────────────────────────┬────────────────────────────────────┘
  ┌─ Client ─────────┐  hop 6: ModelResponse { content: [tool_use|text] }
  │ runAgentLoop      │ ◄──── identical shape to Anthropic's adapter
  └──────────────────┘
```

### Move 2 variant — the load-bearing skeleton

1. **Kernel:** render-tools-to-text + parse-text-to-call + bounded
   retry-on-botched-JSON. That trio *is* the emulation.

2. **What breaks if removed:**
   - Drop `buildSystemText` → Gemma never knows tools exist; the loop
     gets prose forever and the RAG agent can't retrieve.
   - Drop the retry/`RETRY_NUDGE` → one malformed JSON reply kills the
     tool call; local models botch JSON often enough that this is the
     difference between "works" and "flaky."
   - Drop `looksLikeToolAttempt` → you either retry on every plain answer
     (wasted calls, the model gets nagged for tool calls it shouldn't
     make) or never retry (back to flaky). The heuristic is what makes
     the retry *targeted*.

3. **Skeleton vs hardening:** the kernel is the three moves above. The
   `maxToolCallAttempts` clamp (≥1), the abort checks
   (`request.signal?.throwIfAborted()`), and the usage extraction are
   hardening — they make it robust, not functional.

### Move 3 — the principle

An adapter's purpose is to hold a vendor's quirks so the rest of the
system can pretend they don't exist. The measure of a good one is how
much ugliness it absorbs without letting any of it leak through the port.
Gemma's adapter absorbs an entire missing capability — and the agent loop
is byte-identical whether it's talking to Gemma or to Claude. That's
information hiding doing its job at full strength.

---

## Primary diagram

```
  Emulation hidden behind the port — full recap

  ┌─ Client: runAgentLoop ─────────────────────────────────────────┐
  │  sees ModelProvider.complete(req) → ModelContentBlock[]         │
  │  branches on text vs tool_use — NEVER on "which model"          │
  └────────────────────────────┬───────────────────────────────────┘
                               │ the port (guarantee: structured)
  ┌─ Adapter: GemmaModelProvider ▼──────────────────────────────────┐
  │  OUTBOUND  buildSystemText(:133) — tools → system prompt        │
  │  CALL      chat({ messages, stream:false }) → Ollama            │
  │  INBOUND   parseToolCall(:168) — tolerant key matching          │
  │  RETRY     looksLikeToolAttempt(:185)? → +RETRY_NUDGE(:35), loop │
  │  WRAP      toResponse(:116) — standard ModelResponse + usage     │
  └────────────────────────────┬───────────────────────────────────┘
                               │ GemmaChatTransport (text in/out)
  ┌─ Provider: Ollama gemma2:9b ▼───────────────────────────────────┐
  │  no tools array · no structured output · best-effort text       │
  └──────────────────────────────────────────────────────────────────┘
```

---

## Elaborate

This is the adapter role from ports & adapters, doing the specific job
Eric Evans calls an *anti-corruption layer*: a boundary that translates a
foreign model into your own terms so the foreign weirdness can't infect
your core. Gemma's lack of tool-calling is the foreign weirdness; the
`tool_use` block is your term.

Why it earns a file rather than a line in the audit: it's the proof that
the port (`ModelProvider`) was drawn at the right depth. A shallower port
— say, one that exposed `nativeToolsSupported: boolean` — would have
forced the loop to branch per model, and the emulation would have leaked
upward. By keeping the port to `complete()` only, every weakness has to
be solved *below* the line. The port's shape forced the good design.

Read next: `05-injectable-transport-seam.md` — the `GemmaChatTransport`
sub-port that lets you test all of this with zero Ollama.

---

## Interview defense

**Q: Why emulate tool-calling in the adapter instead of branching in the
agent loop?** Because the loop is the client and it depends on the port,
not on any model's capabilities. If the loop branched on "does this model
support tools," every new model would touch the loop, and the loop would
accumulate vendor knowledge — the exact leak the port exists to prevent.
Pushing the emulation into the adapter keeps all vendor quirks below the
port. One client, N adapters, zero branches.

```
  where does the quirk live?

  BAD:  loop branches per model      GOOD: adapter hides the quirk
  ┌──────────┐ if gemma → fake       ┌──────────┐ complete()
  │   loop   │ if claude → native    │   loop   │ ──────────►
  └──────────┘ (quirk leaks up)      └──────────┘ (quirk stays down)
```

Anchor: "the quirk lives below the port, or it leaks above it."

**Q: The retry only fires when the text has a `{`. Isn't that fragile?**
It's a deliberate cheap heuristic, and the alternative is worse. Without
it you'd retry on every plain-prose answer — nagging the model for tool
calls it correctly chose not to make — or never retry and accept flaky
JSON. The `{`-tell distinguishes "tried and botched" from "answered in
prose." It's load-bearing enough that the code comments it (:85). Naming
*why* the retry is conditional is the signal you understood the failure
mode, not just the happy path.

Anchor: "retry the botched attempt, not the honest answer."

---

## See also

- `01-deep-provider-port.md` — the port this adapter satisfies
- `05-injectable-transport-seam.md` — the `GemmaChatTransport` test seam
- `00-overview.md` — adapter role in the PATTERN VOCABULARY
- `audit.md` — lens 2 (deepest module) and lens 7 (the `{` heuristic)
- `../study-prompt-engineering/` — the prompt-side of tool emulation
- `../study-agent-architecture/` — the loop that consumes these blocks
