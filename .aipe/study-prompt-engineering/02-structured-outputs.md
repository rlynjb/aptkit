# 02 — Structured outputs via tool calling and schemas

**Subtitle:** structured output / function calling — schema-first prompting
with validate-and-retry (Industry standard)

## Zoom out, then zoom in

This is the concept where production experience separates hardest from blog
advice. The blog says "use JSON mode." Production says: declare the schema,
let the platform enforce it where it can, validate the parse at *your*
boundary, retry with a stricter prompt on failure, and log the failure rate.
aptkit does all four — and it has to, because half its providers can't
enforce anything.

```
  Zoom out — where the output contract is enforced

  ┌─ Runtime layer ─────────────────────────────────────────────┐
  │  ★ generateStructured ★  validate JSON → retry strict suffix  │ ← we are here
  │  packages/runtime/src/structured-generation.ts:54             │
  │  parseValidatedJson → JsonValidator<T>  (your boundary)       │
  └───────────────────────────┬──────────────────────────────────┘
                              │ ModelProvider.complete()
  ┌─ Provider layer (the seam) ▼───────────────────────────────────┐
  │  Anthropic: native tools[] → platform-enforced tool_use        │
  │  Gemma:    schemas rendered into system text → best-effort JSON │
  └────────────────────────────────────────────────────────────────┘
```

Zooming in: structured output is asking the model for a *typed value*, not
prose. Three ways to get it — native tool calling, a JSON mode, or (the 2026
anti-pattern) "respond only in JSON" begged in the prompt text. aptkit uses
the first where the provider supports it and a careful version of the third
where it doesn't, always backstopped by validation it owns.

## Structure pass

**Layers.** Caller (asks for a schema) → runtime (`generateStructured`
orchestrates) → provider (enforces, or fakes) → parser/validator (the
backstop).

**Axis — who guarantees the output is well-formed?** Trace it down:

```
  Axis: "who guarantees the value matches the schema?"

  caller            → nobody (just asks)
  generateStructured → it RETRIES, but doesn't guarantee
  Anthropic provider → platform guarantees tool_use shape
  Gemma provider    → NOBODY guarantees — prose is legal output
  parseValidatedJson → the ONLY hard guarantee, at your boundary  ← seam
```

**Seam.** The validator (`JsonValidator<T>`) is the load-bearing boundary.
Above it, output is hope. Below it, output is a typed `T` or a logged
failure. Everything upstream is best-effort; the validator is the line
where best-effort becomes a contract.

## How it works

You know how a `fetch()` can return a 200 with a body that doesn't match the
shape your TypeScript says it has — so you validate at the boundary before
trusting it? Structured output is that exact discipline applied to a model
response. The model is an untrusted upstream that *usually* honors the
shape. Let's walk the kernel.

### The kernel — generate, extract, validate, retry

Isolate the smallest thing that's still the pattern:

```
  generate-extract-validate-retry — the load-bearing skeleton

  ┌──────────────────────────────────────────────────────┐
  │  attempt = 1                                           │
  │  ┌──────────────────────────────────────────────┐     │
  │  │ model.complete(messages)                       │     │
  │  │      ▼                                          │     │
  │  │ parseAgentJson(text)   ← strip fences, scan {} │     │
  │  │      ▼                                          │     │
  │  │ validate(parsed)        ← YOUR JsonValidator<T> │    │
  │  │      ▼                                          │     │
  │  │  ok? ── yes ──► return typed value              │     │
  │  │   │  no                                         │     │
  │  │   ▼                                             │     │
  │  │  append strictSuffix to user msg, attempt++     │     │
  │  └──────────────────────────────────────────────┘     │
  │  attempts exhausted ──► return { ok:false, attempts }  │
  └──────────────────────────────────────────────────────┘
```

Each part named by what breaks without it:

- **The validator.** Drop it and a malformed-but-parseable object flows
  downstream as if it were typed — the worst kind of bug, silent.
- **The retry with a strict suffix.** Drop it and a single courteous fence
  (`\`\`\`json ... \`\`\``) is a hard failure instead of a recovered one.
- **The fence-tolerant parse.** Drop it and the most common real failure —
  the model wrapping valid JSON in markdown — defeats the validator before
  it ever runs.
- **The attempt log.** Drop it and you can't tell a flaky model from a
  broken prompt. This is the part juniors omit.

The strict suffix and attempt count are *hardening*. The validator is the
irreducible core — without it there's no contract, just hope.

### Step 1 — the model produces text (maybe well-formed)

`generateStructured` calls the provider and pulls the text out:

```ts
// packages/runtime/src/structured-generation.ts:68
response = await options.model.complete({
  system: options.system, messages, maxTokens, temperature, signal,
});
// ...
const rawText = textFromResponse(response);
const parsed = parseValidatedJson(rawText, options.validate);
```

Note what's *not* here: there's no provider-side `response_format: json`
flag threaded through. The contract is enforced after the call, not
demanded of the call. That's the design choice that makes this work across
a provider that supports JSON mode and one that doesn't.

### Step 2 — the tolerant parse handles the courteous-fence bug

Here is the single most important defensive line in the file. The bug,
straight from production folklore and confirmed in this repo's design: a
model told "respond with JSON" will, being helpful, wrap that JSON in a
markdown code fence. A naive `JSON.parse` chokes on the backticks.

```ts
// packages/runtime/src/json-output.ts:7
export function parseAgentJson(text: string): unknown {
  const fence = text.match(/```(?:json)?\s*([\s\S]*?)```/i);  // strip fence
  const candidate = (fence ? fence[1] : text).trim();
  try { return JSON.parse(candidate); }
  catch { /* fall through to a bounded substring scan */ }
  const start = /* first { or [ */;
  const end   = /* last } or ] */;
  if (start >= 0 && end > start) return JSON.parse(candidate.slice(start, end + 1));
  throw new Error('no parseable json in model output');
}
```

Three escalating tries: strip a fence if present, then plain parse, then
scan for the outermost `{...}`/`[...]` and parse the slice. Internet advice
says "just use JSON mode." In this repo, Gemma has no JSON mode, returns
fenced JSON as a courtesy, and `parseAgentJson` is the only reason the
pipeline survives that. The tolerant parse is not a hack — it's the
acknowledgment that a model is an untrusted upstream.

### Step 3 — the validator is the contract

`parseAgentJson` gets you *a* value; `validate` decides if it's *the* value.
The rubric judge's validator is a good worked example — it checks every
dimension, the score range, the verdict allowlist:

```ts
// packages/evals/src/rubric-judge.ts:185 (createRubricJudgmentValidator)
if (!isRecord(value)) return { ok: false, error: 'judgment must be an object' };
for (const id of dimensionIds) {
  const score = value.dimensions[id];
  if (typeof score.score !== 'number') return { ok:false, error:`dimensions.${id}.score must be a number` };
  if (range && (score.score < range.min || score.score > range.max))
    return { ok:false, error:`dimensions.${id}.score must be between ${range.min} and ${range.max}` };
}
if (!verdicts.has(value.verdict)) return { ok:false, error:'verdict not allowed by the rubric' };
```

This is the boundary. A model that returns a verdict outside the allowlist,
or a score of 11 on a 1–5 scale, gets rejected here and triggers a retry.
The validator carries the actual business rules, not just type shapes.

### Step 4 — retry with a stricter prompt, then give up loudly

On a failed validation, the loop appends a strict suffix to the user message
and tries again:

```ts
// packages/runtime/src/structured-generation.ts:47
const DEFAULT_STRICT_SUFFIX = '\n\nReturn ONLY valid JSON - no prose, no markdown fences.';
// :64  on attempt 2+, appendStrictSuffix(baseMessages, strictSuffix)
```

```
  Comparison — attempt 1 vs attempt 2 (the strict nudge)

  attempt 1 user msg:  "Score this subject: ..."
  attempt 2 user msg:  "Score this subject: ...
                        Return ONLY valid JSON - no prose, no markdown fences."
                        └─ the courteous-fence correction, applied AFTER a fail
```

Bounded at `maxAttempts` (default 2). When it's exhausted it returns
`{ ok: false, error, attempts }` and emits an `error` trace event
(`structured-generation.ts:99`). It does *not* throw a generic exception or
return a garbage object — failure is a typed, logged, observable thing. The
`attempts[]` array is the schema-fail rate your metrics dashboard needs.

### Cross-provider: the same retry wraps two enforcement models

The Anthropic provider passes a native `tools` array and gets
platform-enforced `tool_use` blocks (`anthropic-provider.ts:35`). Gemma can
take no such array, so `buildSystemText` renders the tool schemas into the
system text and a separate retry loop (`RETRY_NUDGE`,
`gemma-provider.ts:35`) coaxes a tool call out of it. `generateStructured`
sits *above* both — it doesn't know or care which enforcement model is
underneath, because its validate-and-retry works either way. That's the
payoff of putting the guarantee at your own boundary: it's provider-neutral.

### When NOT to use structured output

The query agent (`query.ts:50`) ends with "No JSON shape is required - just
the answer text." Open-ended prose answers, exploratory chains, anything a
human reads directly — forcing a schema there buys nothing and costs you the
model's fluency. Structured output is for values another *program* consumes,
not values a human reads. Reach for it at machine boundaries, not at the
final human-facing turn.

## Primary diagram

The whole structured-output path, both providers, the validator as the one
hard line.

```
  Structured output in aptkit — full path

  ┌─ Caller ─────────────────────────────────────────────────────┐
  │  generateStructured({ model, validate: JsonValidator<T> })    │
  └────────────────────────────┬──────────────────────────────────┘
        attempt 1 (or 2 with strict suffix appended) │
  ┌─ Provider seam ─────────────▼─────────────────────────────────┐
  │  Anthropic: tools[] → platform-enforced tool_use blocks       │
  │  Gemma:    schemas in system text + RETRY_NUDGE → best-effort  │
  └────────────────────────────┬──────────────────────────────────┘
        raw text (maybe fenced, maybe prose) │
  ┌─ Parse ──────────────────────▼────────────────────────────────┐
  │  parseAgentJson: strip fence → parse → scan {...} → parse      │
  └────────────────────────────┬──────────────────────────────────┘
  ┌─ Validate (THE CONTRACT) ───▼─────────────────────────────────┐
  │  JsonValidator<T>: shape + ranges + allowlists                │
  │     ok  → return { ok:true, value:T, attempts }               │
  │     no  → retry w/ strict suffix, or { ok:false, attempts }   │
  └────────────────────────────────────────────────────────────────┘
```

## Elaborate

The pattern has a canonical lineage: OpenAI's function calling and
structured outputs, Anthropic's tool use, the broader "constrained
decoding" line of work. The transferable insight is that none of those
platform features remove the need for client-side validation — they reduce
its failure rate. Anthropic's tool use will give you well-shaped `tool_use`
blocks, but it won't enforce *your* business rule that a score lives in
1–5. That's why `createRubricJudgmentValidator` exists even when the
upstream is Claude.

XML-tag-delimited output (Anthropic-leaning) and JSON-mode flags
(OpenAI-leaning) are vendor specifics that would live as adapter details
inside the provider packages — not their own concept. The pattern that
survives across all of them is generate → parse-tolerantly → validate →
retry. aptkit encodes exactly that pattern in `structured-generation.ts`,
the comment on line 51 even naming its origin: "the provider-neutral version
of Dryrun's on-device JSON pipeline."

## Interview defense

**Q: A blog says "use JSON mode." What's the production version?**

JSON mode reduces malformed output; it doesn't eliminate it, and half of
real deployments use models that don't have it. The production version:
declare the schema, enforce it natively where the platform can, but put the
*hard* guarantee at your own boundary — a validator that returns a typed
value or a logged failure — and retry with a stricter prompt on a parse or
validation miss. Log the failure rate so you can tell a flaky model from a
broken prompt.

```
  best-effort upstream ──► parseAgentJson ──► VALIDATOR ──► typed T
                                              ↑ the only hard line
```

Anchor: "`generateStructured` in aptkit — `parseValidatedJson` is the seam;
`parseAgentJson` strips the courteous markdown fence before it."

**Q: Name the load-bearing part people forget in structured output.**

The tolerant parse for the courteous code fence. Models told to emit JSON
wrap it in `\`\`\`json` as a politeness, and a naive `JSON.parse` dies on the
backticks. `parseAgentJson` (`json-output.ts:7`) strips the fence first,
then scans for the outermost braces. Naming that specific bug signals you've
shipped this, not read about it.

Anchor: "Courteous fence — `\`\`\`json` wrapping — strip it before parse."

## See also

- [01-anatomy.md](01-anatomy.md) — where the output contract lives in the
  system prompt
- [07-output-mode-mismatch.md](07-output-mode-mismatch.md) — when one
  chain's JSON meets another expecting prose
- [09-chain-of-thought.md](09-chain-of-thought.md) — putting reasoning in a
  structured `thinking` field instead of free prose
- [05-eval-driven-iteration.md](05-eval-driven-iteration.md) — the
  `attempts[]` log as a schema-fail metric
