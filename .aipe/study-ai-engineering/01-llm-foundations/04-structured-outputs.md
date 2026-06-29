# Structured outputs

Structured outputs · constrained decoding / validated JSON (Industry standard)

You want the model to return `{revenue: 1200, currency: "USD"}`, not a paragraph that mentions revenue. Structured output is putting a typed contract at the LLM boundary and refusing to proceed until the model honors it. aptkit does this with `generateStructured` — prompt for JSON, parse it, validate it, and retry with a stricter nudge if it's malformed. It's TypeScript's "this function returns a `User`" enforced against a thing that emits prose.

## Zoom out, then zoom in

Structured generation wraps `complete()` and sits between a capability and the raw model call.

```
aptkit — where outputs get typed
┌─────────────────────────────────────────────┐
│ Capability (analytics: "extract these fields")│
├─────────────────────────────────────────────┤
│ ★ generateStructured<T>() — prompt+parse+retry│  ← you are here
│      └ parseValidatedJson<T>(text, validate)  │
├─────────────────────────────────────────────┤
│ ModelProvider.complete()                       │
├─────────────────────────────────────────────┤
│ Model — emits text that hopefully is JSON      │
└─────────────────────────────────────────────┘
```

The pattern is "validated decoding via parse-and-retry." The question: *how do you trust unstructured output enough to hand it to typed code?* You don't trust it — you validate it, and you retry on failure. Same instinct as `const data = schema.parse(await res.json())` after a `fetch`: the wire gives you `any`, the validator gives you a `T` or an error. Here the "wire" is a language model, which is messier, so you also retry.

## Structure pass

Three layers: the capability that wants a `T`, `generateStructured` that enforces it, and `complete()` that returns raw text. Trace the **failure** axis.

```
FAILURE axis — what happens when output is wrong-shaped?
Layer                    on bad output
─────────────────────────────────────────────────────
Capability               receives {ok:false, error} — never a half-parsed T
generateStructured       parse fails → append strict suffix → retry ←★ seam
  parseValidatedJson      extract JSON, JSON.parse, run validator → throw or T
complete()               returns whatever text; doesn't care about shape
```

The seam is `generateStructured`. Below it, `complete()` happily returns "Sure! Here's the JSON: ```{...}```" — prose, fences, the works. Above it, the capability only ever sees a clean `{ok:true, value:T}` or a clean failure. The retry loop is where a soft failure (malformed text) becomes either a success or a hard, typed failure — it never leaks a half-valid object.

## How it works

**Mental model.** It's a `fetch`-with-validation loop, but the server occasionally ignores the schema, so you re-ask more firmly. Prompt → get text → strip fences → parse → validate. If any step fails and you have attempts left, append "Return ONLY valid JSON" and go again.

```
generateStructured — the validated-decode loop
  attempt 1: complete() ─▶ raw text ─▶ extract+parse+validate
                                          │
                          ok? ────────────┤
                          yes ─▶ {ok:true, value, attempts}
                          no  ─▶ append strict suffix, attempt 2
  attempt 2: complete() ─▶ raw text ─▶ extract+parse+validate
                          no  ─▶ {ok:false, error, attempts}   (give up)
```

**The retry loop with the strict nudge.** Two attempts by default; on retry it bolts a hard instruction onto the prompt.

```ts
// packages/runtime/src/structured-generation.ts:54-101  (generateStructured<T>)
const maxAttempts = options.maxAttempts ?? 2;                       // :57
const STRICT = '\n\nReturn ONLY valid JSON - no prose, no markdown fences.'; // :58
for (let attempt = 0; attempt < maxAttempts; attempt += 1) {        // :62
  const system = attempt === 0 ? base : base + STRICT;             // :64 stricter on retry
  const res = await provider.complete({ system, messages, ... });
  const parsed = parseValidatedJson<T>(res.content..., validate);  // :84-90
  if (parsed.ok) return { ok: true, value, rawText, attempts };    // :87-89
}
return { ok: false, error, attempts };                              // :100
```

The strict suffix is the "I asked nicely, now I'm asking firmly" move — most malformed outputs are prose wrappers or stray fences, and the firmer instruction usually fixes it on attempt 2. Two attempts is the deliberate ceiling: cheap insurance, not infinite retries.

**The validator turns text into a `T` or throws.** Parsing is split out so it's reusable and testable on its own.

```ts
// packages/runtime/src/json-output.ts:30-45  (parseValidatedJson<T>)
const obj = parseAgentJson(text);       // extract JSON from possibly-messy text
return validate(obj);                   // your type guard: returns T or throws
```

```ts
// packages/runtime/src/json-output.ts:7-28  (parseAgentJson — the extractor)
const fence = text.match(/```(?:json)?\s*([\s\S]*?)```/i);  // :8 strip markdown fences
try { return JSON.parse(candidate); } catch {}              // :11-15 direct parse
// :17-25 bounded substring scan for the first {...} or [...]
throw new Error('no parseable json in model output');       // :27 give up
```

This is the messy reality of "JSON mode" by hand: the model loves to wrap JSON in ```json fences or chatter, so the extractor peels those off, tries a direct parse, then scans for a brace-balanced substring before admitting defeat. `validate` is your own type guard — exactly the runtime check you'd write after a `fetch` to prove the wire data matches your TS type.

**aptkit emulates JSON mode; it doesn't use a native one.** OpenAI and Anthropic have provider-native JSON/grammar modes that constrain decoding so invalid JSON literally can't be emitted. Gemma (local, via Ollama) has none. So aptkit picks the lowest common denominator — prompt + parse + retry — which works on *every* provider including the local one. That's a real design choice: portability over the fast path. The cost is the occasional retry and the extractor's brace-scanning.

**The principle.** Put a validator at every boundary where untyped data meets typed code, and make the failure mode explicit (`{ok:false}`), not a thrown surprise or a half-filled object. An LLM is just the least trustworthy such boundary you'll meet — so it also gets a retry. Constrain, validate, retry, then degrade cleanly.

## Primary diagram

The full Move 2 walk: capability asks for a `T`, the loop prompts/parses/validates with a stricter retry, and the capability gets a clean result either way.

```
generateStructured<T> — full path
  Capability: "give me {revenue, currency}"  + validate()
        │
        ▼
  ┌─ attempt loop (max 2) ───────────────────────────────┐
  │  system = base [+ STRICT suffix if retry]             │
  │     │ complete()                                       │
  │     ▼                                                  │
  │  raw text  ── parseAgentJson ──▶ strip fences /        │
  │                                  JSON.parse / brace-scan│
  │     │ object                                           │
  │     ▼ validate(obj)                                    │
  │  T ──▶ {ok:true, value, attempts} ──────────────▶ done│
  │  throw ──▶ retry with STRICT, or after last:           │
  │           {ok:false, error, attempts} ──────────▶ done│
  └────────────────────────────────────────────────────────┘
```

Either branch returns a typed result object — the capability never touches raw model text.

## Elaborate

Provider-native structured output ("JSON mode," "function calling with strict schemas," grammar-constrained decoding like llama.cpp's GBNF) constrains the *decoder* so malformed JSON can't be produced — strictly better than parse-and-retry when available. aptkit's emulation is the universal fallback. This concept is the sibling of tool calling (a tool call *is* a structured output — see Gemma's emulated tool calling in `08-provider-abstraction.md`). Temperature 0 (see `03-sampling-parameters.md`) is its quiet partner: deterministic decoding makes the retry loop converge. Read `08-provider-abstraction.md` next.

## Project exercises

### Add a provider-native JSON fast path

- **Exercise ID:** `EX-LLM-04a`
- **What to build:** This is implemented (Case A) — the next step is a fast path. Detect when the provider supports native JSON mode (Anthropic/OpenAI) and, when the caller passes a JSON schema, use the native constrained-decoding mode instead of prompt+parse+retry; keep the emulated loop as the fallback for Gemma.
- **Why it earns its place:** Phase 1 mastery is knowing when to drop the portable-but-slow path for the native-and-strict one. You'll learn capability detection on the provider and how to keep one call site that branches on what the adapter can do.
- **Files to touch:** `packages/runtime/src/structured-generation.ts` (54-101); `packages/providers/anthropic/src/anthropic-provider.ts` (28-61); `packages/providers/openai/src/openai-provider.ts`. Optionally add a `supportsJsonMode` flag to the `ModelProvider` type in `packages/runtime/src/model-provider.ts`.
- **Done when:** an Anthropic/OpenAI call with a schema returns valid JSON in one attempt (no retry needed), Gemma still uses the emulated loop, and both paths return the same `{ok, value}` shape.
- **Estimated effort:** `1–2 days`

## Interview defense

**Q: The model returned ```json {...}``` with prose around it — how do you not choke?**

```
  raw: "Sure! ```json\n{\"x\":1}\n``` hope that helps"
        │ parseAgentJson
        ▼
  1. fence regex  → "{\"x\":1}"
  2. JSON.parse   → {x:1}        (or fall to step 3)
  3. brace-scan   → first {...}  (last resort)
  4. else throw "no parseable json"
```

A three-stage extractor: strip fences, direct parse, then scan for a brace-balanced substring; only then give up. Anchor: *peel the wrapper before you parse.*

**Q: Why emulate JSON mode instead of using the provider's native one?**

```
  native JSON mode:  Anthropic ✓  OpenAI ✓  Gemma ✗
  prompt+parse+retry: works on ALL three   ← aptkit picks this
                                            (portability over the fast path)
```

Because Gemma (local) has no native mode, and aptkit must work across every provider; the emulated loop is the only universal option. The cost is the occasional retry. Anchor: *lowest common denominator buys you the local model.*

## See also

- [`03-sampling-parameters.md`](./03-sampling-parameters.md) — temperature 0, the partner of the retry loop.
- [`08-provider-abstraction.md`](./08-provider-abstraction.md) — tool calls as structured output, emulated on Gemma.
- [`01-what-an-llm-is.md`](./01-what-an-llm-is.md) — the typed boundary this enforces.
