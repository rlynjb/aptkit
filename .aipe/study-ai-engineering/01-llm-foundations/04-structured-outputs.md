# Structured outputs — a typed contract at the LLM boundary

**Industry names:** structured generation, JSON-mode, constrained / validated output · *Industry standard*

## Zoom out, then zoom in

A model returns text. Your code needs a typed object. The gap between those two
is where most LLM applications quietly break — the model wraps JSON in prose, or
in a markdown fence, or returns a field as a string when you needed a number.
AptKit closes that gap in one runtime helper that every structured path goes
through. Here's where it sits.

```
  Zoom out — the typed boundary

  ┌─ Callers that need a typed object back ─────────────────────────┐
  │  RubricJudge.judge() · diagnostic / recommendation extraction    │
  └───────────────────────────────┬──────────────────────────────────┘
                                   │  calls
  ┌─ Runtime layer (packages/runtime) ─▼──────────────────────────────┐
  │  ★ generateStructured() ★  ←── THIS CONCEPT                        │
  │    complete → parseAgentJson → JsonValidator → retry once          │
  └───────────────────────────────┬──────────────────────────────────┘
                                   │  model.complete()
  ┌─ Provider layer ───────────────▼──────────────────────────────────┐
  │  returns text (maybe fenced, maybe with prose around the JSON)     │
  └─────────────────────────────────────────────────────────────────────┘
```

Zoom in: structured output is the discipline of treating the LLM's response as
*untrusted input that must pass a typed contract* before your code touches it.
You don't hope the model returns clean JSON — you extract it defensively,
validate it against a hand-written checker, and if it fails, you nudge the model
once and try again. `generateStructured` is that pipeline. This is the key file
in this section, because it's the seam every downstream typed value depends on.

## Structure pass

**Layers.** Three: *generate* (call the model), *extract* (`parseAgentJson` — pull
JSON out of whatever text came back), *validate* (a `JsonValidator<T>` — confirm
the parsed thing matches the type you need). Wrapped around all three: a retry.

**Axis — trust: how much do you trust the data at each layer?** Trace it. Out of
`complete()`: zero trust — it's a string that *might* contain JSON. After
`parseAgentJson`: parsed, but still `unknown` — syntactically JSON, semantically
unverified. After the validator: fully trusted `T` — every field checked. Trust
climbs one rung per layer.

**Seam.** The load-bearing seam is `JsonValidator<T>`: `(value: unknown) →
{ ok: true, value: T } | { ok: false, error }`. On one side, `unknown` from a
model. On the other, a typed `T` the rest of the code can rely on. That boolean
result is the gate — and on the `false` side, the retry fires.

## How it works

You've parsed an HTTP response body: `JSON.parse(await res.text())`, then checked
the shape before using it. Structured generation is that, hardened for a source
that's *creatively wrong* — a model might add "Here's the JSON you asked for:"
before the object, or wrap it in ```` ```json ````, or trail an explanation after
the closing brace.

### Move 1 — the mental model

The pattern is *generate → extract → validate → (retry)*. Each arrow is a
trust-raising step; the retry is the loop that gives a wrong answer one more
chance with a stricter instruction.

```
  The structured-generation pipeline

  ┌──────────┐   text   ┌──────────────┐  unknown  ┌────────────┐
  │ complete │ ───────► │ parseAgentJson│ ────────► │ validate(T)│
  └──────────┘          └──────────────┘           └─────┬──────┘
       ▲                                                 │
       │ ok:false → append strict suffix, retry          │ ok:true
       └─────────────────── (attempt < maxAttempts) ◄─────┤
                                                          ▼
                                                   typed value T
```

The brain (model) is unreliable; the pipeline is the discipline that makes its
output safe to use. The retry isn't optional polish — it's the difference between
"one bad sample fails the whole run" and "one bad sample costs one extra call."

### Move 2 — the load-bearing skeleton

Strip it to the kernel that's still the pattern:

```
  Kernel — generateStructured (pseudocode)

  for attempt in 1 .. maxAttempts:             // maxAttempts default 2
    messages = attempt == 1
      ? baseMessages
      : appendStrictSuffix(baseMessages)        // ← the nudge, attempt 2+
    response = model.complete({ system, messages, maxTokens, temperature })
    rawText  = text blocks of response, joined
    parsed   = parseValidatedJson(rawText, validate)   // extract THEN validate
    if parsed.ok:
      return { ok: true, value: parsed.value }   // ← trusted T, done
    // else: record the error, loop to nudge + retry
  return { ok: false, error: lastError }
```

**Name each part by what breaks without it:**

- **`parseAgentJson` (the extractor).** Drop it and `JSON.parse` chokes the
  instant the model adds one word of prose or a fence. It does two things in
  order: match a ```` ```json ... ``` ```` fence and parse what's inside; if that
  fails, scan for the first `{` or `[` and the last `}` or `]` and parse that
  substring. Without this, every "Sure! Here's the JSON:" prefix is a hard
  failure.
- **`JsonValidator<T>` (the gate).** Drop it and you return whatever parsed —
  maybe a number where you needed a string, maybe a missing field. The validator
  is what turns `unknown` into a typed `T` *you can trust*. In AptKit these are
  **hand-written functions**, not a schema library — a plain
  `(value) => { ok, value | error }`. Be precise about this: there is no Zod in
  the structured pipeline.
- **The retry loop with the strict suffix.** Drop it and one malformed sample
  fails the call. On attempt 2+, AptKit appends `"Return ONLY valid JSON — no
  prose, no markdown fences."` to the last user message — a targeted nudge at the
  exact failure mode `parseAgentJson` had to work around. `maxAttempts` defaults
  to 2: one shot, one nudge.
- **`attempts[]` (the audit trail).** Drop it and a failure is opaque. Every
  attempt records its raw text and error, so a caller can see *what* the model
  returned and *why* validation rejected it.

**Skeleton vs. hardening.** The kernel is generate → extract → validate → retry.
Hardening layered on top: trace emission (`model_usage`, `warning`, `error`
events per attempt), abort-signal handling, and the configurable `strictSuffix`.
The crude-but-deliberate part is `parseAgentJson`'s bounded substring scan — it's
not a real JSON tolerant-parser, just "first opener to last closer," which is
enough for the prose-around-JSON case without parsing balanced braces.

### Move 2.5 — the extractor, step by step

`parseAgentJson` is where the "untrusted input" mindset earns its keep. Watch it
handle three kinds of model output:

```
  parseAgentJson — three inputs, one extractor (execution trace)

  input A: '{"verdict":"pass"}'
    → fence match? no → JSON.parse(whole) → OK ✓

  input B: '```json\n{"verdict":"pass"}\n```'
    → fence match? YES → parse the captured group → OK ✓

  input C: 'Here is the result: {"verdict":"pass"}. Hope that helps!'
    → fence match? no → JSON.parse(whole) → throws
    → scan: first '{' at 21, last '}' at 39
    → JSON.parse(slice(21, 40)) → OK ✓

  input D: 'I could not determine a verdict.'
    → fence? no → parse? throws → no '{' or '[' found
    → throw 'no parseable json in model output'  → validator never runs
```

The fence regex runs first because a fenced block is the cleanest signal. The
substring scan is the fallback for prose-wrapped JSON. And input D is the honest
failure: when there's genuinely no JSON, it throws, the parse fails, and the
retry (or final failure) takes over. The scan is bounded and dumb on purpose —
first opener to last closer — which can over-grab on adversarial input but is
right for the real-world "model added a sentence" case.

### Move 3 — the principle

Treat every model response as untrusted input crossing a typed boundary. The
contract isn't "the model returns JSON" — that's a hope. The contract is "this
text must extract, parse, and validate into `T`, or it doesn't pass." Validation
is the gate, retry is the recovery, and the typed `T` on the far side is the only
thing the rest of your system is allowed to depend on. Every reliable LLM feature
in AptKit — the rubric judge, the agent loop's `parseResult` — is this pattern
wearing a different validator.

## Primary diagram

The full pipeline, both attempts, every trust transition labelled.

```
  generateStructured — full picture

  GenerateStructuredOptions { model, validate, system, messages|userPrompt,
                              maxTokens, temperature, retry{maxAttempts=2,
                              strictSuffix}, trace }
        │
        ▼
  ┌──────────────── for attempt in 1..maxAttempts ─────────────────────┐
  │  messages = attempt==1 ? base : appendStrictSuffix(base)           │
  │       │                          └ "Return ONLY valid JSON…"        │
  │       ▼                                                            │
  │  model.complete({ system, messages, maxTokens, temperature })      │
  │       │  ── emit model_usage trace                                 │
  │       ▼                                                            │
  │  rawText = join(text blocks)         ← UNTRUSTED string            │
  │       ▼                                                            │
  │  parseAgentJson:  fence /```json…```/  else  {…}/[…] substring scan │
  │       ▼                              ← unknown (parsed, unverified) │
  │  validate(parsed):  hand-written JsonValidator<T>                  │
  │       │                                                            │
  │   ok:true ──► return { ok:true, value: T, rawText, attempts }      │ ← TRUSTED
  │   ok:false ─► record attempt; attempt<max ? loop+nudge : fail      │
  └──────────────────────────────────────────────────────────────────────┘
        │
        ▼
  { ok:false, error, attempts[] }   ← every raw text + error preserved
```

## Implementation in codebase

**Use cases.** `RubricJudge.judge()` is the headline caller — it asks the model to
score a subject against a rubric and *must* get back a typed `RubricJudgment`
(dimension scores in range, an allowed verdict, a fix string), so it calls
`generateStructured` with a validator generated from the rubric definition. The
diagnostic and recommendation agents use the same helper to turn investigation
results into typed objects. The agent loop's own `parseResult` (in
`run-agent-loop.ts`) is a sibling of this pattern — same parse-and-validate
discipline, applied to the loop's final text.

**The retry kernel**, `packages/runtime/src/structured-generation.ts:62-96`:

```
  packages/runtime/src/structured-generation.ts  (lines 62-96)

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {  ← bounded retry
    const messages = attempt === 1
      ? baseMessages
      : appendStrictSuffix(baseMessages, strictSuffix);   ← nudge on retry only
    response = await options.model.complete({ system, messages,
                                              maxTokens, temperature, signal });
    emitUsage(options, response);                         ← trace every attempt
    const rawText = textFromResponse(response);           ← UNTRUSTED text
    const parsed  = parseValidatedJson(rawText, options.validate);  ← extract+validate
    if (parsed.ok) {
      return { ok: true, value: parsed.value, rawText, attempts };  ← trusted T
    }
    attempts.push({ attempt, rawText, error: parsed.error });       ← audit trail
  }
       │
       └─ maxAttempts default 2 (line 57): one normal shot, one strict-suffix
          retry. The suffix targets exactly the failure parseAgentJson works
          around — prose and fences.
```

**The strict suffix**, `packages/runtime/src/structured-generation.ts:47`:

```
  packages/runtime/src/structured-generation.ts  (line 47)

  const DEFAULT_STRICT_SUFFIX =
    '\n\nReturn ONLY valid JSON - no prose, no markdown fences.';
       │
       └─ Appended to the last user message on attempt 2+ (appendStrictSuffix,
          :109-122). It names the two failure modes the extractor had to
          tolerate — so the retry attacks the cause, not just re-rolls.
```

**The extractor**, `packages/runtime/src/json-output.ts:7-28`:

```
  packages/runtime/src/json-output.ts  (lines 7-28)

  const fence = text.match(/```(?:json)?\s*([\s\S]*?)```/i);  ← fence first
  const candidate = (fence ? fence[1] : text).trim();
  try { return JSON.parse(candidate); } catch { /* fall through */ }

  const objectStart = candidate.indexOf('{');                ← bounded scan:
  const arrayStart  = candidate.indexOf('[');                  first opener…
  const start = min(of the non-negative ones);
  const end   = max(lastIndexOf('}'), lastIndexOf(']'));       …to last closer
  if (start >= 0 && end > start)
    return JSON.parse(candidate.slice(start, end + 1));
  throw new Error('no parseable json in model output');       ← honest failure
       │
       └─ Not a balanced-brace parser — just first-opener-to-last-closer.
          Enough for "model added a sentence"; intentionally crude.
```

**A real validator (hand-written, not Zod)**,
`packages/evals/src/rubric-judge.ts:185-224`: `createRubricJudgmentValidator`
returns a `(value: unknown) => JsonValidation<RubricJudgment>` that checks
`value` is an object, every rubric dimension is present with a numeric `score` in
the rubric's declared `[min,max]` range and a string `reason`, the `verdict` is
one the rubric allows, and `fix` is a string — returning a precise `error` string
on the first failure. This is the shape of every AptKit validator: explicit
field-by-field checks, no schema DSL.

## Elaborate

Structured generation exists because the LLM API contract (text in, text out)
doesn't match the application contract (typed object in, typed object out). The
industry has three broad answers: (1) provider JSON-mode / function-calling that
*constrains* generation so the output is valid by construction; (2) schema
libraries (Zod, Pydantic) that parse-and-coerce after the fact; (3) the
extract-validate-retry loop AptKit uses. AptKit's choice is deliberate and worth
defending: hand-written validators keep the runtime dependency-free and let the
error message be exactly as specific as the rubric needs (`dimensions.clarity.score
must be between 1 and 5`), and the retry handles the messy-prose reality without
depending on any one vendor's JSON-mode.

The cost is that AptKit doesn't *constrain* generation — it lets the model emit
whatever and cleans up after. A provider that supports strict JSON-mode could
make `parseAgentJson`'s substring scan unnecessary. But the extract-validate-retry
loop is provider-neutral, which is the same value the `ModelProvider` contract
buys everywhere else (`08-provider-abstraction.md`): it works identically against
Anthropic, OpenAI, or a fixture.

Adjacent: the agent loop's `parseResult` + recovery turn is the same discipline
applied to a loop's final answer
(`../04-agents-and-tool-use/03-react-pattern.md`); the rubric judge that consumes
this helper is the eval layer's centerpiece
(`../05-evals-and-observability/`); temperature's interaction with retry is in
`03-sampling-parameters.md`. Designing the *prompt* that makes valid JSON more
likely is prompt-engineering territory (`.aipe/study-prompt-engineering/`, *not
yet generated*).

## Project exercises

*Provenance: Phase 1 — LLM foundations (C1.x). No `aieng-curriculum.md` present;
IDs are by-phase convention. Case A — the pipeline exists; these harden it.*

### Exercise — escalate the retry nudge with the actual error

- **Exercise ID:** `[C1.4]` Phase 1, structured outputs
- **What to build:** On retry, append not just the static strict suffix but the
  *specific* validator error from the failed attempt (e.g. "your last response
  failed: `dimensions.clarity.score must be between 1 and 5`"). The error is
  already captured in `attempts[]`.
- **Why it earns its place:** A generic "return only JSON" nudge fixes fences and
  prose; it does nothing for a semantically wrong field. Feeding the exact
  validator error back is targeted recovery — and it shows you understand that
  the validator's error string is a teaching signal, not just a rejection.
- **Files to touch:** `packages/runtime/src/structured-generation.ts`,
  `packages/runtime/test/structured-generation.test.ts`.
- **Done when:** A fixture that returns an out-of-range score on attempt 1 and a
  valid one on attempt 2 shows the second request carried the specific error
  text, proven by a unit test.
- **Estimated effort:** `1–4hr`

### Exercise — a JSON-mode-aware extractor fast path

- **Exercise ID:** `[C1.5]` Phase 1, structured outputs
- **What to build:** When the provider was asked for strict JSON (a new request
  hint) and returns clean JSON, skip the fence/substring scan and parse directly,
  recording in the trace which path was taken.
- **Why it earns its place:** It surfaces the tradeoff between constrain-at-source
  and clean-up-after, and makes the extractor's crudeness a deliberate fallback
  rather than the only path.
- **Files to touch:** `packages/runtime/src/json-output.ts`,
  `packages/runtime/src/structured-generation.ts`, the adapters, tests.
- **Done when:** A test shows clean JSON takes the fast path and prose-wrapped
  JSON still falls back to the scan.
- **Estimated effort:** `4hr–1d`

## Interview defense

**Q: The model is supposed to return JSON but sometimes wraps it in prose. How do
you get a reliable typed object?**
"Extract-validate-retry, and I never trust the raw text. I'd draw it:"

```
  text ─► parseAgentJson ─► unknown ─► validate(T) ─► T
   ▲  (fence, else {…}/[…] scan)            │
   └──── ok:false: append "JSON only" + retry once ◄┘
```

"`generateStructured` in `structured-generation.ts`. Extraction tries a markdown
fence first, then a bounded first-`{`-to-last-`}` substring scan. The result goes
through a hand-written validator — not Zod, a plain
`(unknown) => {ok, value|error}`. If validation fails, attempt 2 re-prompts with
'Return ONLY valid JSON — no prose, no markdown fences.' `maxAttempts` is 2."
*Anchor: the model's output is untrusted input crossing a typed boundary.*

**Q: Why validators by hand instead of a schema library?**
"Two reasons. The runtime stays dependency-free — `packages/runtime` imports no
schema lib. And the error messages are exactly as specific as the domain needs:
the rubric validator says `dimensions.clarity.score must be between 1 and 5`,
which is both the rejection *and* the retry signal. It's
`createRubricJudgmentValidator` in `rubric-judge.ts:185`."
*Anchor: the validator's error string does double duty — gate and teaching signal.*

## Validate

- **Reconstruct:** From memory, write the `generateStructured` kernel — the four
  skeleton parts (extract, validate, retry+nudge, audit trail). Check
  `packages/runtime/src/structured-generation.ts:62-96`.
- **Explain:** Why does `parseAgentJson` try the fence regex *before* the
  substring scan? (A fenced block is the cleanest, least ambiguous signal; the
  scan is the messy fallback for prose-wrapped JSON — `json-output.ts:8-23`.)
- **Apply:** The model returns `Here is your answer: {"verdict":"pass"}` on
  attempt 1. Walk it through. (Fence: no. `JSON.parse(whole)`: throws. Scan: first
  `{` to last `}`, parse the slice → succeeds → validator runs. No retry needed —
  `json-output.ts:17-24`.)
- **Defend:** Why retry with a strict suffix rather than just raising temperature
  or failing? (The suffix attacks the exact failure modes — prose and fences —
  that the extractor had to tolerate; one extra call recovers a salvageable
  sample. `structured-generation.ts:47`, `:109-122`.)

## See also

- [01-what-an-llm-is.md](01-what-an-llm-is.md) — the text-out function this pipeline parses
- [03-sampling-parameters.md](03-sampling-parameters.md) — temperature's interaction with the retry
- [../04-agents-and-tool-use/03-react-pattern.md](../04-agents-and-tool-use/03-react-pattern.md) — `parseResult` + recovery, the same discipline in the loop
- [../05-evals-and-observability/](../05-evals-and-observability/) — the rubric judge, the headline caller
