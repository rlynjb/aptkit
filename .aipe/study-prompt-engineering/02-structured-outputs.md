# 02 — Structured outputs via tool calling and schemas

**Industry name:** structured outputs / tool calling / JSON mode — *Industry standard*

## Zoom out, then zoom in

I have shipped features that depend on structured output, and every one of them
broke at least once because somebody added a polite instruction to a prompt that
was relying on JSON parsing, and the model started wrapping its
schema-conformant JSON inside a markdown code fence as a courtesy. Parser broke.
The lesson that survives production: **structured output is a pipeline — declare
a schema, let the provider enforce it where it can, validate at the boundary,
and retry on failure — not an instruction you put in the prompt text.**

Here's where that pipeline sits in this repo.

```
  Zoom out — where structured output lives

  ┌─ Authoring ───────────────────────────────────────────────┐
  │  diagnostic.ts: "Return ONLY a JSON object ... {shape}"    │
  │  rubric-judge.ts: "Output JSON only ... exactly this shape"│
  └───────────────────────────┬────────────────────────────────┘
  ┌─ Runtime (the pipeline) ──▼────────────────────────────────┐
  │  ★ structured-generation.ts generateStructured() ★         │ ← we are here
  │     generate → parseAgentJson → validate → retry(strict)   │
  └───────────────────────────┬────────────────────────────────┘
  ┌─ Provider ────────────────▼────────────────────────────────┐
  │  Anthropic/OpenAI: native tool_use   Gemma: emulated JSON   │
  └───────────────────────────┬────────────────────────────────┘
  ┌─ Parse ───────────────────▼────────────────────────────────┐
  │  json-output.ts parseAgentJson() — fence-strip + scan       │
  └──────────────────────────────────────────────────────────────┘
```

Zoom in: the interesting code is `generateStructured`
(`packages/runtime/src/structured-generation.ts:54`). It's the difference
between the blog-post version ("use JSON mode") and the production version
("generate AND tolerantly parse AND validate against a typed contract AND retry
with a stricter system suffix AND emit a warning trace on each fail so your
dashboard sees the schema-fail rate").

## The structure pass

**Layers:** prompt (asks for a shape) → provider (may enforce natively, may not)
→ parse (tolerant extraction) → validate (typed contract) → retry (stricter).

**Axis — where is the schema *enforced*?** This is the axis that makes the
boundaries pop, because the answer flips depending on the provider.

```
  Axis: "who enforces the schema?" — and where it flips

  ┌─ Anthropic / OpenAI ─┐   seam    ┌─ Gemma (no native tools) ─┐
  │ PROVIDER enforces    │ ═══╪═════► │ PROMPT TEXT + parse-retry │
  │ (native tool_use)    │ (it flips) │ enforce it best-effort     │
  └──────────────────────┘            └────────────────────────────┘
        ▲                                       ▲
        └──── same need, two enforcement points ┘
              → ALWAYS validate at the boundary regardless
```

**Seam:** the provider boundary. On Anthropic/OpenAI the schema is a real
contract the API enforces. On Gemma the "schema" is just text in the system
prompt (`gemma-provider.ts:133`) and a hope. The load-bearing lesson: because
that seam exists, **you validate at the boundary on both sides** — never trust
that the model honored the shape, because half your providers can't enforce it.
`parseValidatedJson` (`json-output.ts:30`) is that boundary check.

## How it works

### Move 1 — the mental model

You already do this with a `fetch()`: you don't trust the response body, you
`JSON.parse` it inside a try/catch and you check the fields before using them.
Structured output is the same defensive read, except the "server" is a language
model that's *more* likely to hand you malformed or fence-wrapped JSON than a
real API is. The strategy: ask for the shape, parse tolerantly, validate
strictly, retry once with a sterner instruction.

```
  Pattern — the structured-output retry loop

   attempt 1 ──► generate ──► parseAgentJson ──► validate ──┐
      ▲                                                      │ ok? ──► return value
      │                                              fail    │
      └──── append strictSuffix ◄───────────────────────────┘
            "Return ONLY valid JSON - no prose, no markdown fences."
            (bounded: maxAttempts, default 2)
```

### Move 2 — walking generateStructured

**Step 1 — the prompt asks for a shape.** The system prompt names the exact JSON
shape. Look at `rubric-judge.ts:158` — it builds an `outputShape` object, then
literally appends `JSON.stringify(outputShape)` after "Use exactly this shape:".
The diagnostic agent does the same with a fenced example (`diagnostic.ts:28`).
**What breaks without it:** the model invents its own field names and your
validator rejects everything.

**Step 2 — generate, then tolerantly parse.** After `model.complete`,
`generateStructured` calls `textFromResponse` then `parseValidatedJson`
(`structured-generation.ts:84-85`). The tolerance lives in `parseAgentJson`
(`json-output.ts:7`):

```
  Inline annotation — json-output.ts:7 parseAgentJson

  const fence = text.match(/```(?:json)?\s*([\s\S]*?)```/i);  ← strip markdown fence
  const candidate = (fence ? fence[1] : text).trim();          ← the courteous-fence bug, handled
  try { return JSON.parse(candidate); }                        ← happy path
  catch { /* fall through */ }
  const start = Math.min(objectStart, arrayStart);             ← else: scan for first { or [
  const end   = Math.max(lastIndexOf('}'), lastIndexOf(']'));  ← ...to last } or ]
  return JSON.parse(candidate.slice(start, end + 1));          ← carve the JSON out of prose
```

That fence-strip on line 8 is exactly the bug I opened this file with — a model
wrapping clean JSON in ` ```json ` because the prompt sounded conversational.
Here it's defended *in the parser*, not by begging the model.

**Step 3 — validate against a typed contract.** `parseValidatedJson` hands the
parsed value to a `JsonValidator<T>` (`json-output.ts:30`). The rubric judge's
validator (`rubric-judge.ts:185`) checks every dimension exists, scores are
numbers in the allowed range, the verdict is one the rubric permits. This is the
boundary check — the "validate at the boundary" move. **What breaks without it:**
malformed-but-parseable JSON (a string where a number belongs) flows downstream
and explodes three layers later, far from the cause.

**Step 4 — retry with a stricter suffix.** On a validation fail and
`attempt < maxAttempts`, the next loop appends `DEFAULT_STRICT_SUFFIX`
(`structured-generation.ts:47`): *"Return ONLY valid JSON - no prose, no markdown
fences."* `appendStrictSuffix` (`:109`) walks backward to find the last user
message and tacks the suffix on. **The boundary condition:** retries are bounded
(`maxAttempts`, default 2, `:57`) — unbounded retry against a model that
*can't* produce the shape just burns tokens. After the cap it returns
`{ ok: false }` and emits an `error` trace (`:99`).

**Step 5 — observability.** Every attempt pushes a `StructuredGenerationAttempt`
(`:60`) and `emitWarning`/`emitError` push trace events (`:145`, `:154`). That's
how the schema-fail rate becomes a number on a dashboard instead of a silent
degradation. This is the line that separates the blog-post version from
production.

**The Gemma variant — same shape, different enforcement.** Because Gemma has no
native tool calling, its provider runs its *own* version of this loop for tool
calls (`gemma-provider.ts:62`): up to `maxToolCallAttempts` (default 2), and on
retry it appends `RETRY_NUDGE` (`:35`): *"Your previous reply was not a valid
tool call. Respond with ONLY a single JSON object…"*. The clever bit:
`looksLikeToolAttempt` (`:185`) only retries if the text contains a `{` — plain
prose is treated as a real answer, not a botched tool call. **When NOT to
retry** is itself a design decision.

### Move 3 — the principle

**The prompt is the least reliable part of structured output; the validator is
the most reliable.** Internet advice says "tell the model to return JSON." In a
production system that instruction is necessary but does almost none of the work
— the work is done by tolerant parsing, boundary validation, bounded retry, and
the metrics that catch the regression. Push the reliability down the stack into
code, because the layer you control (the validator) is the only layer that can't
have a bad day.

**When NOT to use structured output:** open-ended generation (the query agent
returns plain prose on purpose — `query.ts:48`, "No JSON shape is required"),
and exploratory chains where forcing a schema would amputate the answer.

## Primary diagram

The full pipeline across both enforcement worlds.

```
  Structured output — full pipeline, both providers

  PROMPT          system prompt names the shape (rubric-judge.ts:158)
                          │
  RUNTIME    generateStructured (structured-generation.ts:54)
                          │  model.complete
        ┌─────────────────┴──────────────────┐
  PROVIDER  Anthropic/OpenAI            Gemma (no native tools)
        native tool_use enforces    buildSystemText renders schema
        the schema                  INTO system text (gemma:133)
        └─────────────────┬──────────────────┘
                          │  raw text back
  PARSE      parseAgentJson — fence-strip + substring scan (json-output.ts:7)
                          │
  VALIDATE   JsonValidator<T> at the boundary (json-output.ts:30)
                  ok ─────┴───── fail
                  │              │  append strictSuffix, retry (bounded)
               return         emit warning/error trace → dashboard
```

## Elaborate

Tool calling, JSON mode, and `response_format` are three points on one
spectrum: how much the *provider* guarantees the shape. Native tool_use
(Anthropic/OpenAI) is strongest; constrained JSON mode is middle; "please return
JSON" in text (the only option for Gemma) is weakest. The vendor specifics:
Anthropic leans on `tool_use` content blocks and XML-ish structure; OpenAI has
`tools` plus strict `response_format`; Gemma/Ollama has neither, which is *why*
this repo had to build the emulation in `gemma-provider.ts`. The pattern —
declare, parse, validate, retry — survives all three; only the enforcement point
moves. The canonical reference is the OpenAI cookbook's structured-output guide
and Anthropic's tool-use docs; both say the same thing this repo's code says:
validate the output, don't trust it.

## Interview defense

**Q: Why isn't "respond only in JSON" enough?** Because half of providers can't
enforce it (Gemma has no native tools), and even providers that can will
occasionally wrap output in a markdown fence as a courtesy when the prompt reads
conversationally. You always validate at the boundary and retry with a stricter
instruction. The prompt instruction is necessary but does the least work.

```
  generate → parse(tolerant) → validate(typed) → retry(strict, bounded)
                  ▲                                    │
                  └──────────── fail ──────────────────┘
  prompt asks for shape · code enforces it
```
*Anchor: `generateStructured` (`structured-generation.ts:54`); `parseAgentJson`
fence-strip (`json-output.ts:8`).*

**Q: The load-bearing part people forget?** The **bound on retries**
(`maxAttempts`, `:57`) and the **fence-strip** in the parser (`json-output.ts:8`).
Without the bound you burn tokens forever on a model that can't comply; without
the fence-strip the single most common structured-output bug — courteous code
fences — silently breaks your parse.

## See also

- `01-anatomy.md` — the output-contract section the schema lives in.
- `07-output-mode-mismatch.md` — what happens when the declared mode and the
  consumer disagree.
- `05-eval-driven-iteration.md` — `rubric-judge.ts` is structured output judging
  structured output.
- `../study-ai-engineering/` — the serving-side view of structured generation.
