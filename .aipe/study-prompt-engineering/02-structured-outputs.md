# 02 — Structured outputs

**Industry name(s):** structured output / JSON mode / schema-validated
generation. **Type:** Industry standard.

## Zoom out, then zoom in

Here's the most important file in this guide for production reliability. Three of
AptKit's four agents return typed objects, not prose, and the path from "model
emitted some text" to "I have a validated `Recommendation[]`" is where systems
break in production. Look at where that path sits.

```
  Zoom out — where structured output is enforced

  ┌─ Prompt layer ──────────────────────────────────────────────┐
  │  "Return ONLY a JSON array ... in a json fence"  ← contract   │
  └───────────────────────────┬──────────────────────────────────┘
                             │  model emits text
  ┌─ Runtime layer (packages/runtime) ─▼────────────────────────┐
  │  ★ parseAgentJson → parseResult/validate → recoveryPrompt ★  │ ← we are here
  └───────────────────────────┬──────────────────────────────────┘
                             │  validated typed value OR null
  ┌─ Agent layer ────────────▼──────────────────────────────────┐
  │  tryParseRecommendations → Recommendation[]  (or [])         │
  └───────────────────────────────────────────────────────────────┘
```

Now zoom in. AptKit does **not** use provider tool-calling-for-output or
`response_format`. It asks for JSON in a markdown fence in the prompt text, then
defends the parse: extract from the fence, validate the shape at the boundary,
and on failure re-prompt once. That's the 2026-unfashionable choice — and the
file is honest that schema-mode would be stronger — but the *discipline* around
it (validate, retry, fall back to `[]`) is exactly right.

## Structure pass

**Layers.** Three: the *prompt contract* (says "return JSON"), the *extractor*
(`parseAgentJson` pulls JSON from possibly-fenced text), and the *validator*
(`tryParseRecommendations` checks every field). Each is a separate, swappable
piece.

**Axis — held constant: "who is trusted to produce a valid object here?"**

```
  One question down the structured-output stack: who's trusted?

  ┌─ prompt contract ─────────┐  → MODEL is asked (not trusted)
  │ "Return ONLY a JSON array"│
  └───────────────────────────┘
  ┌─ parseAgentJson ──────────┐  → EXTRACTOR trusted to find JSON in messy text
  │ fence match → substring   │
  └───────────────────────────┘
  ┌─ validator ───────────────┐  → CODE is the source of truth (field by field)
  │ isRecommendationArray     │
  └───────────────────────────┘
```

**Seam — the parse boundary.** The load-bearing seam is between "text the model
produced" and "typed value the rest of the code uses." Trust flips here: above
it, nothing the model says is trusted; below it, the value is guaranteed to match
the type or it's `null`. Every structured-output bug lives at this seam.

## How it works

#### Move 1 — the mental model

You already do this with a `fetch()` that returns JSON: you don't trust
`res.json()` to be the shape you want — you check it, and you handle the case
where it isn't. Structured output from an LLM is the same, except the "server"
is a model that returns valid JSON 95% of the time and wraps it in a code fence
or adds a "Here's your answer:" preamble the other 5%.

```
  Structured output — the parse-validate-recover kernel

        model text
            │
            ▼
     ┌─────────────┐   no JSON found
     │ extract     │ ───────────────┐
     │ (parseJson) │                │
     └──────┬──────┘                │
            │ candidate object      │
            ▼                       │
     ┌─────────────┐   shape wrong  │
     │ validate    │ ───────────────┤
     └──────┬──────┘                │
            │ ok                    ▼
            ▼                 ┌──────────────┐
        typed value          │ recover:     │
                             │ re-prompt 1x │──► validate again ──► value | []
                             └──────────────┘
```

#### Move 2 — the walkthrough

**The contract in the prompt.** Every structured agent ends its system prompt
with an explicit output section: the recommendation prompt says "Return ONLY a
JSON array in a json fenced block of at most 3 objects." This is a request, not
an enforcement — the model can still ignore it. **Breaks if missing:** the model
returns prose and there's nothing to parse.

**Extraction — `parseAgentJson`.** The first defense. It tries, in order: match
a ```` ```json ```` fence and parse its contents; if that fails, scan for the
first `{` or `[` and the last `}` or `]` and parse the substring. This is the
fix for the single most common structured-output bug in production: the
courteous model that wraps clean JSON in a markdown fence, or prefixes it with
"Here is the array:". A naive `JSON.parse(text)` throws on both; the fence match
and substring scan survive both.

```
  parseAgentJson — two extraction strategies

  model text: "Here is the array:\n```json\n[{...}]\n```\nHope that helps!"
                                    │
              strategy 1: fence regex ```json ... ```
                                    ▼
                              "[{...}]"  → JSON.parse → ✓

  model text: "Sure! [{...}] done"
                                    │
              strategy 2: indexOf('[') .. lastIndexOf(']')
                                    ▼
                              "[{...}]"  → JSON.parse → ✓
```

**Validation — `tryParseRecommendations` / `isRecommendationArray`.** Parsing
gets you `unknown`. Validation makes it typed. Every field is checked: `title` is
a string, `bloomreachFeature` is one of the taxonomy values, `steps` is a string
array, `confidence` is one of `high|medium|low`. A field the model invented or
omitted fails the check and the whole thing is rejected. **Breaks if missing:**
malformed objects flow downstream and blow up far from the prompt, where they're
miserable to debug.

```
  Validation — code is the source of truth, field by field

  unknown → isRecord? → title:string? → bloomreachFeature in taxonomy?
          → steps: string[]? → confidence in {high,medium,low}? → ... → typed
            any check fails ─────────────────────────────────────► reject
```

**Recovery — the second prompt.** When parse/validate returns `null` and a
`recoveryPrompt` is supplied, the loop runs ONE more model call. The recovery
prompt re-injects the prior tool results and a stricter instruction, with a fresh
system that says "Output ONLY the structured answer ... Never ask for more data."
**Breaks if missing:** a single bad turn loses the whole run; with it, the agent
gets one disciplined retry before falling back to `[]`. (The `generateStructured`
path does the same idea differently — see below.)

**The retry variant — `generateStructured`.** The rubric judge uses a different
loop. It does up to 2 attempts; on the second it *appends a strict suffix* to the
user message ("Return ONLY valid JSON — no prose, no markdown fences"). Same
philosophy — don't trust, validate, retry once — different mechanism.

#### Move 3 — the principle

"Use JSON mode" is the blog-post answer. The production answer is: ask for JSON
**and** extract defensively **and** validate every field at the boundary **and**
have a recovery turn **and** fall back to a safe empty value. AptKit does four of
those five; the one it skips (provider-enforced schema mode) would make the
extractor's job easier but doesn't remove the need to validate. The validator is
the source of truth — never the prompt.

## Primary diagram

The full structured-output path for the recommendation agent.

```
  Recommendation agent — structured output end to end

  ┌─ Prompt ─────────────────────────────────────────────────────┐
  │ system: "...Return ONLY a JSON array of at most 3 objects..."  │
  └───────────────────────────┬───────────────────────────────────┘
                             │ runAgentLoop (maxTurns 6, maxToolCalls 4)
                             ▼
  ┌─ last turn: synthesisInstruction appended ───────────────────┐
  │ "Stop querying now ... Respond with ONLY a JSON array..."      │
  └───────────────────────────┬───────────────────────────────────┘
                             │ model text
                             ▼
        parseAgentJson  ──►  tryParseRecommendations(taxonomy)
                             │                    │
                       parsed=null          parsed ok
                             │                    │
                             ▼                    ▼
              recoveryPrompt(toolCalls) ──► .slice(0,3).map(assign id) → Recommendation[]
                             │
                       still null → return []
```

## Implementation in codebase

**Use cases.** Recommendation, diagnostic, and monitoring agents all return
typed objects through this path. The rubric judge uses the `generateStructured`
retry variant instead.

The extractor — two strategies, fence then substring scan:

```
  packages/runtime/src/json-output.ts  (lines 7–28)

  export function parseAgentJson(text: string): unknown {
    const fence = text.match(/```(?:json)?\s*([\s\S]*?)```/i);  ← strategy 1: fenced
    const candidate = (fence ? fence[1] : text).trim();
    try { return JSON.parse(candidate); } catch { /* fall through */ }
    const objectStart = candidate.indexOf('{');                 ← strategy 2: scan
    const arrayStart = candidate.indexOf('[');
    const start = Math.min(...[objectStart, arrayStart].filter(i => i >= 0));
    const end = Math.max(candidate.lastIndexOf('}'), candidate.lastIndexOf(']'));
    if (start >= 0 && end > start) return JSON.parse(candidate.slice(start, end + 1));
    throw new Error('no parseable json in model output');
        │
        └─ the fence match IS the fix for the courteous-model bug. Without it,
           a model that helpfully wraps JSON in ```json breaks JSON.parse(text).
```

The forced-synthesis instruction that guarantees a final emit on the last turn:

```
  packages/runtime/src/run-agent-loop.ts  (lines 72–74, 101–109)

  export function buildSynthesisInstruction(middle: string): string {
    return `You have NO more tool calls available. ${middle} Do not say you need more queries.`;
  }
  ...
  const budgetSpent = maxToolCalls !== undefined && toolCalls.length >= maxToolCalls;
  const forceFinal = turn === maxTurns - 1 || budgetSpent;
  const response = await model.complete({
    system: forceFinal && synthesisInstruction ? `${system}\n\n${synthesisInstruction}` : system,
    messages,
    tools: forceFinal ? undefined : toolSchemas,   ← tools removed → model MUST answer
        │
        └─ stripping tools on the final turn is load-bearing: it's what makes the
           model emit the JSON instead of requesting another query.
```

The recommendation synthesis + recovery wiring, with the safe fallback:

```
  packages/agents/recommendation/src/recommendation-agent.ts  (lines 88–98)

  synthesisInstruction: buildSynthesisInstruction(
    'Stop querying now and output your final answer. Respond with ONLY a JSON
     array of at most 3 recommendation objects in a json fence, or [] ...'),
  parseResult: (text) => tryParseRecommendations(text, this.taxonomy),
  recoveryPrompt: (toolCalls) => buildRecoveryPrompt(anomaly, diagnosis, toolCalls),
  });
  if (!parsed) return [];                          ← safe fallback, never throws
  return parsed.slice(0, 3).map((recommendation) => ({ id: this.idGenerator(), ...recommendation }));
        │
        └─ .slice(0,3) enforces the "at most 3" contract in CODE, not just the
           prompt — the model's count is not trusted.
```

The retry variant used by the rubric judge — strict suffix on attempt 2:

```
  packages/runtime/src/structured-generation.ts  (lines 47, 62–95)

  const DEFAULT_STRICT_SUFFIX = '\n\nReturn ONLY valid JSON - no prose, no markdown fences.';
  ...
  const messages = attempt === 1 ? baseMessages : appendStrictSuffix(baseMessages, strictSuffix);
  ...
  const parsed = parseValidatedJson(rawText, options.validate);
  if (parsed.ok) return { ok: true, value: parsed.value, rawText, attempts };
        │
        └─ the strict suffix is only added on retry — the second attempt is
           strictly more constrained than the first. That's the cheap reliability buy.
```

## Elaborate

The defensive parse is the right call *because* AptKit is provider-neutral: it
runs against Anthropic, OpenAI, a fallback chain, and a local guard. Provider
schema modes differ in syntax and guarantees across vendors, so coding to any one
of them would couple the core to a vendor. JSON-in-fence + validate is the lowest
common denominator that works everywhere. The cost: you carry the extractor and
must validate every field by hand.

The honest weakness: provider tool-calling-for-output (or strict `response_format`)
would cut the schema-fail rate at the source and you could drop strategy-2 of the
extractor. The repo doesn't log a schema-fail *rate* to a metrics dashboard
either — it emits a `warning` trace event on validation failure
(`structured-generation.ts:94`) but doesn't aggregate it. That aggregation is the
production hygiene this file would add next: you can't tell a prompt is drifting
under a model upgrade if you're not watching the parse-fail rate.

This connects directly to 05 (the eval layer is where you'd catch a rising
schema-fail rate) and 07 (the contract that says "this capability returns JSON"
is what makes a mode mismatch a code-review-catchable bug).

## Interview defense

**Q: How do you get reliable structured output from an LLM?**
Don't trust the prompt — validate at the boundary. Ask for JSON, extract it
defensively (fence match then substring scan, because courteous models wrap JSON
in code fences), validate every field against the expected type, and on a parse
miss re-prompt once with a stricter instruction. Fall back to a safe empty value;
never throw downstream.

```
  ask JSON → extract (fence|scan) → validate fields → ok? value : recover(1x) → [] 
                                         ▲
                                  code is the source of truth, not the prompt
```
Anchor: "`parseAgentJson` then `tryParseRecommendations`, recovery turn in
`run-agent-loop.ts:195`."

**Q: What's the most common structured-output bug you've hit?**
The courteous model. It returns schema-conformant JSON wrapped in a ```` ```json ````
fence or after a "Here's your answer:" preamble, and a naive `JSON.parse(text)`
throws. The fix is extraction that survives both — the fence regex at
`json-output.ts:8`. Add `\nbe concise` to a prompt relying on strict JSON and
you'll see it the same day.

**Q: Why strip the tools on the final turn?**
So the model can't ask for another query — it's forced to emit the answer.
`forceFinal ? undefined : toolSchemas` at `run-agent-loop.ts:106`. Without it a
tool-happy model keeps calling tools until it runs out of turns and never
produces the JSON.

## Validate

- **Reconstruct:** Draw the parse → validate → recover kernel from memory.
- **Explain:** Why does `parseAgentJson` need *both* the fence match and the
  substring scan (`json-output.ts:8` vs `:17`)? Give a model output that defeats
  each one alone.
- **Apply:** Add a new required `urgency` field to recommendations. Which file's
  validator changes, and what does the recovery prompt need to say?
- **Defend:** A teammate wants to delete the recovery turn "because the model
  almost always returns valid JSON." Argue for keeping it using the
  `if (!parsed) return []` fallback at `recommendation-agent.ts:95`.

## See also

- [01-anatomy.md](01-anatomy.md) — the output-contract section of the prompt.
- [05-eval-driven-iteration.md](05-eval-driven-iteration.md) — where you'd watch the schema-fail rate.
- [07-output-mode-mismatch.md](07-output-mode-mismatch.md) — prose vs JSON, declared per capability.
- [09-chain-of-thought.md](09-chain-of-thought.md) — reasoning as a JSON field, not free prose.
