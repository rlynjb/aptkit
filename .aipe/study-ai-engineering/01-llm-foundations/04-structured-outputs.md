# Structured outputs — turning prose into a typed value

**Subtitle:** generateStructured + validators + retry · text → validated T · *Industry standard*

## Zoom out, then zoom in

Before you trust a model's JSON, see where the parsing-and-validating machinery
sits: it wraps the raw model call so your capability only ever sees a typed value
or a clean failure.

```
  Zoom out — where structured generation sits

  ┌─ Capability ────────────────────────────────────────────────┐
  │  rubric judge / any "give me JSON" task                     │
  └───────────────────────────┬─────────────────────────────────┘
                              │ generateStructured({ validate })
  ┌─ Runtime ─────────────────▼─────────────────────────────────┐
  │  ★ generateStructured ★  prompt → parse → validate → retry  │ ← we are here
  └───────────────────────────┬─────────────────────────────────┘
                              │ complete()
  ┌─ The model ───────────────▼─────────────────────────────────┐
  │  emits text that is SUPPOSED to be JSON (maybe fenced, maybe │
  │  with prose around it)                                       │
  └──────────────────────────────────────────────────────────────┘
```

The model returns *text*, not a typed object — even when you beg it for JSON.
Structured output is the discipline of treating that text as untrusted input:
extract the JSON substring, parse it, validate it against a schema you wrote, and
if any step fails, nudge the model and try again a bounded number of times. The
output is a discriminated result: `{ok:true, value}` or `{ok:false, error}`. No
exceptions thrown into your capability for a model that mumbled.

## Structure pass

**Layers.** Capability (defines the validator) → `generateStructured` (orchestrates
parse/validate/retry) → `parseAgentJson` (extracts JSON from messy text) →
validator (your typed gate) → result.

**Axis — trust.** Trace how trusted the data is as it climbs. Raw model text:
zero trust. After `parseAgentJson`: it's at least valid JSON. After the
validator: it's a typed `T` you can hand to the rest of the program. Trust is
*manufactured* by each layer, never assumed.

**Seam.** The flip is the validator. Below it, `unknown` from a stochastic model.
Above it, a concrete `T`. That single function is where "the model said
something" becomes "the program has a value."

## How it works

### Move 1 — the mental model

You already do this at every TypeScript boundary: data crosses in as `unknown`
(an API response, a form), and you narrow it with a type guard before using it.
`generateStructured` is a type guard for a function whose "API" is a language
model — same pattern, except the source can be wrong in creative new ways, so you
add retries.

```
  The boundary you already know vs the one here

  fetch().json()  : unknown ─► guard ─► T          (you do this daily)
  model.complete(): text    ─► parse ─► guard ─► T  (+ retry if it lies)
                              parseAgentJson  validator
```

### Move 2 — the moving parts

**Extracting JSON from messy text.** Models wrap JSON in ```json fences or sandwich
it in prose. `parseAgentJson` strips fences, tries a straight parse, then falls
back to a bounded substring scan for the first `{`/`[` to the last `}`/`]`. From
`packages/runtime/src/json-output.ts:7`:

```ts
export function parseAgentJson(text: string): unknown {
  const fence = text.match(/```(?:json)?\s*([\s\S]*?)```/i);  // ← strip ```json fences
  const candidate = (fence ? fence[1] : text).trim();
  try {
    return JSON.parse(candidate);                             // ← happy path
  } catch { /* fall through to substring scan */ }
  const start = /* first { or [ */ …;
  const end = Math.max(candidate.lastIndexOf('}'), candidate.lastIndexOf(']'));
  if (start >= 0 && end > start) return JSON.parse(candidate.slice(start, end + 1));
  throw new Error('no parseable json in model output');
}
```

```
  parseAgentJson fallback ladder

  fenced ```json block ──► strip ──┐
  raw JSON.parse ──────────────────┼─► success
  substring scan {…} / […] ────────┘
  none of the above ──► throw "no parseable json"
```

**Validating into a typed value.** `parseValidatedJson` runs the parse, then hands
the result to a `JsonValidator<T>` you supply. The rubric judge's validator
(`rubric-judge.ts:170`) checks every dimension is a number in range, the verdict
is allowed, and `fix` is a string — rejecting anything off-shape:

```ts
return (value: unknown): JsonValidation<RubricJudgment> => {
  if (!isRecord(value)) return { ok: false, error: 'judgment must be an object' };
  // every dimension must be a number within its declared min..max
  if (typeof score.score !== 'number') return { ok: false, error: `dimensions.${id}.score must be a number` };
  if (range && (score.score < range.min || score.score > range.max))
    return { ok: false, error: `dimensions.${id}.score must be between …` };
  if (!verdicts.has(value.verdict)) return { ok: false, error: 'verdict not allowed' };
  return { ok: true, value: { dimensions, verdict: value.verdict, fix: value.fix.trim() } };
};
```

```
  validator = your schema as code

  unknown ─► shape? ─► types? ─► ranges? ─► allowed enums? ─► T
            any NO ──────────────────────────────────────► {ok:false,error}
```

**The bounded retry with a strict nudge.** If validation fails, `generateStructured`
appends a strict suffix and tries again — default twice. From
`packages/runtime/src/structured-generation.ts:62`:

```ts
for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {        // ← default maxAttempts = 2
  const messages = attempt === 1 ? baseMessages
    : appendStrictSuffix(baseMessages, strictSuffix);                // ← only on retry
  const response = await options.model.complete({ system, messages, … });
  const parsed = parseValidatedJson(textFromResponse(response), options.validate);
  if (parsed.ok) return { ok: true, value: parsed.value, rawText, attempts };
  attempts.push({ attempt, rawText, error: parsed.error });          // ← record every miss
}
return { ok: false, error, attempts };                               // ← never throws for bad JSON
```

The strict suffix is literally `'\n\nReturn ONLY valid JSON - no prose, no
markdown fences.'` (`structured-generation.ts:47`).

```
  Retry loop (maxAttempts = 2)

  attempt 1 ─► parse+validate ─► ok? ─► return {ok:true,value}
       │ no
  append DEFAULT_STRICT_SUFFIX
       ▼
  attempt 2 ─► parse+validate ─► ok? ─► return / else {ok:false,error,attempts}
```

### Move 3 — the principle

Treat model output as untrusted input crossing a boundary, exactly like a network
response. Extract, parse, validate against a schema you own, and give the model
one bounded second chance with a sharper instruction. Return a result type, never
throw — the caller decides what a malformed model does to the program.

## Primary diagram

```
  Structured generation end to end

  capability                generateStructured                   model
  ┌──────────┐ validate     ┌─────────────────────────────┐ text ┌────────┐
  │ rubric   │ ───────────► │ 1 prompt → complete()       │ ───► │ "{…}"  │
  │ judge    │              │ 2 parseAgentJson (strip,scan)│ ◄─── │ (maybe │
  │          │ ◄─────────── │ 3 validate → T?             │      │ fenced)│
  └──────────┘ {ok,value}   │ 4 fail → +strict suffix,retry│     └────────┘
                            └─────────────────────────────┘
   above: a typed RubricJudgment  │  below: stochastic text, up to 2 tries
```

## Elaborate

Some vendors offer native "JSON mode" or schema-constrained decoding that
guarantees parseable output. aptkit can't rely on that because its default model
is local Gemma with no such guarantee — so it builds the safety net in code:
extract, validate, retry. This is the same shape as `04-agents-and-tool-use`
tool-call parsing (Gemma emits tool calls as JSON it then parses). Read
`03-sampling-parameters.md` for why this retry net lets aptkit skip a hard
temperature lock, and `09-user-override-locks.md` for validating fields a human
may have edited.

## Project exercises

### Add a third attempt with an even stricter nudge
- **Exercise ID:** —  (no curriculum file in repo)
- **What to build:** extend the retry to optionally include a "here is the exact
  shape: {…}" example on attempt 3, behind `retry.maxAttempts`, with a test using
  a fixture that fails twice then succeeds.
- **Why it earns its place:** teaches escalation strategy — each retry should add
  information, not just repeat — and exercises the result/attempts contract.
- **Files to touch:** `packages/runtime/src/structured-generation.ts`,
  `packages/runtime/test/structured-generation.test.ts`.
- **Done when:** the test proves attempt 3 fires with the example and succeeds.
- **Estimated effort:** `1–4hr`

### Write a validator for a brand-new structured task
- **Exercise ID:** —  (no curriculum file in repo)
- **What to build:** a `JsonValidator<T>` for a small new shape (e.g. a tagging
  result `{tags: string[], confidence: number}`) plus a `generateStructured` call
  and tests covering a good response, a fenced response, and an out-of-range one.
- **Why it earns its place:** you can't claim to do structured output until you've
  written the validator that manufactures the trust.
- **Files to touch:** new file under `packages/runtime/src` or an agent package,
  plus a matching `test/` file.
- **Done when:** all three fixture cases pass/fail as designed.
- **Estimated effort:** `1–4hr`

## Interview defense

**Q: "The model returned `Sure! Here's the JSON: ```json {…}```` — how do you handle it?"**
`parseAgentJson` strips the ```json fence first; if that fails it scans from the
first `{` to the last `}`. Then the validator narrows it to a typed value. If both
fail, retry once with a strict "JSON only" suffix.

```
  prose + ```json fence + braces ──► strip fence ──► parse ──► validate ──► T
                                  └─ fail ─► substring {…} scan ─► parse
```
Anchor: *model output is untrusted input; extract, validate, retry.*

**Q: "Why return a result object instead of throwing on bad JSON?"**
Because a model mumbling is an *expected* outcome, not an exceptional one. A
`{ok:false, error, attempts}` lets the caller branch — fall back, degrade,
surface a warning — instead of unwinding the stack on routine flakiness.

```
  throw       ─► caller must try/catch everywhere, easy to forget
  result type ─► caller MUST handle ok:false, attempts visible for tracing
```
Anchor: *a malformed model is a value to handle, not an exception to catch.*

## See also

- `03-sampling-parameters.md` — the retry net that offsets unset temperature
- `06-token-economics.md` — each retry is another `model_usage` event (more tokens)
- `01-what-an-llm-is.md` — why `content` is text blocks you must parse
