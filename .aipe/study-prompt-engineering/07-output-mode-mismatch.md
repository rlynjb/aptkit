# 07 — Output mode mismatch

**Industry name(s):** output contract / format mismatch. **Type:**
Language-agnostic.

## Zoom out, then zoom in

Every AptKit capability declares one output mode: prose or JSON. The query agent
returns plain text; monitoring, diagnostic, and recommendation return validated
JSON. The bug this concept names is what happens when a consumer expects one mode
and the producer emits the other. Look at where the modes diverge.

```
  Zoom out — two output modes, declared per capability

  ┌─ Agent layer ───────────────────────────────────────────────┐
  │  query           → PROSE  (finalText, no parse)              │
  │  ★ monitoring    → JSON   (parseResult → Anomaly[]) ★         │ ← mode is a
  │  ★ diagnostic    → JSON   (parseResult → Diagnosis) ★         │   per-capability
  │  ★ recommendation→ JSON   (parseResult → Recommendation[]) ★  │   contract
  └───────────────────────────┬──────────────────────────────────┘
                             │  runAgentLoop with/without parseResult
  ┌─ Runtime layer ──────────▼──────────────────────────────────┐
  │  parseResult supplied → JSON mode; absent → prose mode        │
  └───────────────────────────────────────────────────────────────┘
```

Now zoom in. The pattern: the output mode is encoded in *whether the loop has a
`parseResult` callback*. Supply one and the run is JSON-mode (parse, validate,
recover). Omit it and the run is prose-mode (return `finalText` verbatim). The
mismatch bug is feeding a JSON-mode consumer a prose-mode producer's output.

## Structure pass

**Layers.** Two: the *contract* (the prompt's output section + the loop's
`parseResult` presence) and the *consumer* (downstream code that expects a typed
value or a string).

**Axis — held constant: "what type does this stage return?"**

```
  One question across capabilities: return type?

  ┌─ query ───────────────────┐  → string (prose)   — no parseResult
  ┌─ monitoring ──────────────┐  → Anomaly[]         — parseResult + tryParseAnomalies
  ┌─ diagnostic ──────────────┐  → Diagnosis         — parseResult + tryParseDiagnosis
  ┌─ recommendation ──────────┐  → Recommendation[]  — parseResult + tryParseRecommendations
```

**Seam — the `parseResult` switch.** The load-bearing seam is the presence or
absence of `parseResult` in the loop options. It's the single bit that flips a run
from prose to JSON. A mismatch is a wrong setting at this seam: a consumer that
calls `JSON.parse` on a prose agent's `finalText`, or one that reads `.conclusion`
off a string.

## How it works

#### Move 1 — the mental model

You already hit this with HTTP: a client that sets `Accept: application/json` and
gets back `text/html` breaks. Content type is a contract. An agent's output mode
is its content type — and the parser on the other end assumes one.

```
  Output mode as a content-type contract

  producer declares mode          consumer expects mode
  ┌──────────────────┐            ┌──────────────────┐
  │ JSON (parseResult)│ ── must ──►│ typed value      │  ✓
  │ PROSE (finalText) │ ─ match ──►│ string           │  ✓
  │ PROSE             │ ───────────│ JSON.parse(...)  │  ✗ MISMATCH → throws/garbage
  └──────────────────┘            └──────────────────┘
```

#### Move 2 — the walkthrough

**The prompt declares the mode in words.** Prose agents say so: the query prompt's
output section reads "No JSON shape is required - just the answer text." JSON
agents say the opposite: "Return ONLY a JSON array in a json fence." **Breaks if
missing:** the model guesses, and guesses inconsistently — sometimes prose,
sometimes JSON — and your consumer can't rely on either.

**The loop encodes the mode in `parseResult`.** This is where the mode is real,
not just requested. The query agent calls `runAgentLoop` with *no* `parseResult`
and reads `finalText`. The recommendation agent passes
`parseResult: tryParseRecommendations` and reads `parsed`. **Breaks if missing:**
the wiring and the prompt disagree — a JSON prompt with no `parseResult` returns
raw text the caller didn't expect.

```
  parseResult presence = the mode switch

  query-agent:          runAgentLoop({ ... })           → const { finalText }   (prose)
  recommendation-agent: runAgentLoop({ parseResult }) → const { parsed }       (JSON)
                                       │
                                       └─ this one option IS the content-type setting
```

**The mismatch is a code-review-catchable bug.** Because the mode lives in two
visible places — the prompt's output line and the loop's `parseResult` — a
reviewer can check they agree. A diagnostic agent whose prompt says "return JSON"
but whose call omits `parseResult` is wrong on the page, before any test runs.
**Breaks if missing the review:** the mismatch ships and surfaces as a
parse-throw at a handoff, far from the cause.

**The fallback reveals the mode too.** Prose agents fall back to a default string
(`FALLBACK_ANSWER`); JSON agents fall back to a safe empty value (`return []`) or a
`FALLBACK_DIAGNOSIS` object. The fallback's *type* must match the declared mode.
**Breaks if missing:** a JSON agent that falls back to a string crashes the typed
consumer on the unhappy path — the exact path you didn't test.

#### Move 3 — the principle

Declare one output mode per stage, in the prompt and in the wiring, and make them
agree. The mode is a contract between producer and consumer; a mismatch is the
same class of bug as a content-type mismatch, and it's catchable in review because
it lives in two named places.

## Primary diagram

The two modes, side by side, with their full wiring.

```
  Two output modes — prose vs JSON, end to end

  ┌─ PROSE mode (query) ──────────────────────────────────────────┐
  │ prompt:  "No JSON shape is required - just the answer text."   │
  │ loop:    runAgentLoop({ ... })            (no parseResult)      │
  │ read:    const { finalText } = ...                             │
  │ return:  finalText.trim() || FALLBACK_ANSWER   (string)        │
  └────────────────────────────────────────────────────────────────┘

  ┌─ JSON mode (recommendation) ──────────────────────────────────┐
  │ prompt:  "Return ONLY a JSON array ... of at most 3 objects."  │
  │ loop:    runAgentLoop({ parseResult: tryParseRecommendations })│
  │ read:    const { parsed } = ...                                │
  │ return:  parsed ? parsed.slice(0,3).map(addId) : []  (typed[]) │
  └────────────────────────────────────────────────────────────────┘
                   mismatch = JSON consumer ⟵ prose producer (or vice versa)
```

## Implementation in codebase

**Use cases.** The query agent is the one prose capability; it answers free-form
questions in natural language. The other three are JSON capabilities feeding typed
consumers (and each other, in the pipeline — see 06).

Prose mode — no `parseResult`, returns `finalText`:

```
  packages/agents/query/src/query-agent.ts  (lines 85–101)

  const { finalText } = await runAgentLoop({
    capabilityId: QUERY_CAPABILITY_ID,
    ...
    synthesisInstruction: buildSynthesisInstruction(
      'Now answer the user question directly and concisely in plain prose...'),
  });   ← NO parseResult key → prose mode
  return finalText.trim() || FALLBACK_ANSWER;   ← string fallback matches the mode
       │
       └─ the synthesis instruction asks for prose, the loop has no parser, the
          fallback is a string. All three agree → no mismatch.
```

The query prompt's output section explicitly disclaiming JSON:

```
  packages/prompts/src/query.ts  (lines 48–50)

  ## Output
  Give a clear, concise answer in plain prose. ... No JSON shape is required
  - just the answer text.
       │
       └─ the prompt-side half of the contract. A reviewer sees "no JSON" here
          and "no parseResult" in the wiring — they agree, so the mode is sound.
```

JSON mode — `parseResult` supplied, returns a typed value:

```
  packages/agents/recommendation/src/recommendation-agent.ts  (lines 91, 95–98)

  parseResult: (text) => tryParseRecommendations(text, this.taxonomy),  ← JSON mode
  ...
  if (!parsed) return [];                                  ← typed[] fallback matches mode
  return parsed.slice(0, 3).map((r) => ({ id: this.idGenerator(), ...r }));
       │
       └─ prompt says "Return ONLY a JSON array", loop has a parser, fallback is [].
          If any of these three disagreed, that's the mismatch bug.
```

The diagnostic agent's object-typed fallback, matching its JSON mode:

```
  packages/agents/diagnostic-investigation/src/diagnostic-agent.ts  (lines 78, 82)

  parseResult: tryParseDiagnosis,
  ...
  const diagnosis = parsed ?? FALLBACK_DIAGNOSIS;   ← object fallback, not a string
       │
       └─ the unhappy-path return type matches the happy-path type. A string here
          would crash the downstream recommendation stage that reads .conclusion.
```

## Elaborate

Output-mode mismatch is a small concept with an outsized debugging cost, because
the failure surfaces far from the cause. A diagnostic stage that accidentally
returns prose doesn't fail in the diagnostic agent — it fails three lines into the
recommendation agent when `{diagnosis}` gets `JSON.stringify`'d into something
nonsensical, or when a consumer reads `.conclusion` off a string and gets
`undefined`. The fix is upstream: keep the mode in two visible places (prompt
output line, loop `parseResult`) so review catches the disagreement.

AptKit's design makes this hard to get wrong: the `parseResult` callback is the
mode switch, the prompt's output section states the mode in words, and the
fallback's type pins it on the unhappy path. The one thing to watch in review is a
JSON prompt paired with a missing `parseResult` — the run would silently return
raw text. There's no type-level coupling forcing the prompt and the wiring to
agree; that coupling lives in human review and the eval suite (05).

Where it connects: 02 (the JSON mode's parse-validate-recover machinery), 06 (each
pipeline stage declares its mode, and the handoff is where a mismatch bites), and
05 (a mode mismatch is exactly the kind of regression a promoted-fixture replay
catches).

## Interview defense

**Q: What's an output-mode mismatch and why is it nasty?**
A producer emits one format (prose) and the consumer expects another (JSON) —
same class of bug as an HTTP content-type mismatch. It's nasty because it surfaces
far from the cause: a stage that returns prose instead of JSON fails downstream
when a consumer parses or reads a field off a string. The fix is keeping the mode
in two visible places so review catches the disagreement.

```
  prompt "return JSON"  ✓        prompt "return JSON"  ✓
  loop parseResult      ✓        loop parseResult      ✗  ← MISMATCH ships as
  → typed value                  → raw text returned       a downstream throw
```
Anchor: "mode = `parseResult` presence; `query-agent.ts:85` (none) vs
`recommendation-agent.ts:91` (supplied)."

**Q: How do you make a mismatch catchable in code review?**
Put the mode in two named, visible places that must agree: the prompt's `## Output`
section and the loop's `parseResult`. A reviewer reads "Return ONLY JSON" in the
prompt and checks `parseResult` exists in the call. The fallback type is the third
tell — a JSON agent must fall back to a typed value, not a string.
Anchor: "`query.ts:48` says no-JSON; `query-agent.ts:101` returns a string — they
agree."

## Validate

- **Reconstruct:** Name the one loop option that switches a run between prose and
  JSON mode.
- **Explain:** Why must the diagnostic agent's fallback be `FALLBACK_DIAGNOSIS`
  (an object) and not a string (`diagnostic-agent.ts:82`)? What breaks downstream
  if it's a string?
- **Apply:** A new agent's prompt says "Return JSON" but the call omits
  `parseResult`. What does the caller actually receive, and where do you fix it?
- **Defend:** Argue why output mode belongs in *both* the prompt and the wiring
  rather than just one, using the "surfaces far from the cause" failure pattern.

## See also

- [02-structured-outputs.md](02-structured-outputs.md) — the JSON mode's parse machinery.
- [06-single-purpose-chains.md](06-single-purpose-chains.md) — modes at pipeline handoffs.
- [05-eval-driven-iteration.md](05-eval-driven-iteration.md) — fixtures catch a mode regression.
