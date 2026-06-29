# 07 — Output mode mismatch

**Subtitle:** output-mode mismatch — when one chain's format meets another's
expectation (Project-specific)

## Zoom out, then zoom in

Every chain declares one output mode — prose or structured. The bug is when
chain A emits JSON and the consumer of A expects prose, or vice versa, and
the parser silently breaks. aptkit makes the mode explicit per capability,
and the tolerant parser is the seam that absorbs the mismatch when a model
gets it wrong.

```
  Zoom out — output mode declared per capability, absorbed at the parse seam

  ┌─ Capability (declares its mode) ────────────────────────────┐
  │  query agent      → PROSE   ("No JSON shape is required")    │ ← we are here
  │  intent classifier→ ONE WORD (substring-parsed)              │
  │  diagnostic/recs  → STRUCTURED (validator-gated JSON)        │
  └───────────────────────────┬──────────────────────────────────┘
                              │ output text
  ┌─ ★ Parse seam ★ ──────────▼───────────────────────────────────┐
  │  prose → trim & use as-is   |   structured → parseAgentJson    │
  └────────────────────────────────────────────────────────────────┘
```

Zooming in: output mode is the contract on a chain's *return shape*. Declare
it once, in the schema or the prompt's Output section, and make sure every
consumer reads it the same way. The mismatch is a contract violation between
producer and consumer — exactly the kind of bug that doesn't throw, it just
produces garbage downstream.

## Structure pass

**Layers.** Producer capability (emits in its mode) → parse seam (interprets
the text) → consumer (uses the parsed value).

**Axis — does the consumer interpret the output the way the producer emitted
it?** Trace it:

```
  Axis: "do producer and consumer agree on the output mode?"

  query agent → prose,  consumer reads prose      → MATCH   ✓
  intent      → one word, parseIntent substring   → MATCH   ✓
  diagnostic  → JSON,   consumer JSON.parse        → MATCH   ✓
  diagnostic  → JSON in fence, naive JSON.parse    → MISMATCH ✗ (fence!)
                                  └─ parseAgentJson absorbs it
```

**Seam.** The parse seam is load-bearing precisely because it's where a
mismatch surfaces — or gets silently swallowed. A naive parser turns a mode
mismatch into a crash or a wrong value. A tolerant parser absorbs the common
mismatches (the courteous fence) but cannot fix a genuine prose-vs-JSON
disagreement.

## How it works

You know the bug where one function returns `{ data }` and the caller
destructures `{ items }` — no type error if it's `any`, just `undefined`
flowing downstream. Output-mode mismatch is that, across a model call. Let's
walk how aptkit declares modes and where mismatches live.

### Step 1 — prose mode, declared explicitly

The query agent declares prose, in words, in its Output section:

```ts
// packages/prompts/src/query.ts:50
## Output
Give a clear, concise answer in plain prose. A few sentences or short
markdown bullets are fine. ... No JSON shape is required - just the answer text.
```

The consumer matches: `QueryAgent.answer` returns `finalText.trim()`
(`query-agent.ts:101`) — it reads the text as-is, no parse. Producer says
prose, consumer reads prose. Match.

### Step 2 — structured mode, declared in the prompt and enforced by a validator

The recommendation agent declares JSON, precisely:

```ts
// packages/prompts/src/recommendation.ts:54
## Output
Return ONLY a JSON array in a json fenced block of at most 3 objects.
Each object must have:
- title: string
- bloomreachFeature: scenario | segment | campaign | voucher | experiment
- ...
```

The consumer matches by running the text through `parseAgentJson` and a
validator. Producer says JSON (in a fence!), consumer parses tolerantly.
Match — and note the prompt *asks* for a fenced block, anticipating the
courteous-fence behavior rather than fighting it.

### Step 3 — the mismatch, and where it bites

Here's the bug in motion. Suppose a prompt edit "to make it more readable"
adds "explain your reasoning first" to a chain whose consumer does
`JSON.parse(text)`. Now the model emits a paragraph of prose, *then* the
JSON. Naive parse:

```
  Comparison — naive parse vs tolerant parse on a mode drift

  model output: "Based on the data, here are the recommendations:
                 ```json
                 [ {...} ]
                 ```"

  naive JSON.parse(output)        → THROWS (prose prefix + fence)   ✗
  parseAgentJson(output)          → strips fence, finds [...], parses ✓
    json-output.ts:7 — fence match, then substring scan for [ ... ]
```

The tolerant parser (`parseAgentJson`) absorbs *this* mismatch — the
courteous prose-and-fence wrapper — because it strips the fence and scans
for the outermost array. That's the seam doing its job. But it cannot
rescue a genuine disagreement: if the consumer wants prose and the producer
emits JSON, `parseAgentJson` succeeds and hands a JSON value to a consumer
that wanted a sentence. No error, wrong shape, garbage downstream.

### Step 4 — how to spot mismatches in code review

The review heuristic, concrete for this repo:

```
  Spotting a mode mismatch in review

  1. find the producer's Output section  (prompt: "Return ONLY JSON" / "prose")
  2. find the consumer's read            (parseAgentJson? or finalText.trim()?)
  3. do they agree?
       prose ↔ trim()            → ok
       JSON  ↔ parseAgentJson    → ok
       JSON  ↔ trim()            → MISMATCH (JSON leaks as a string)
       prose ↔ parseAgentJson    → MISMATCH (parse throws or mis-parses)
```

The structured chains validate, which makes a mismatch *loud* — the
validator rejects a prose answer. The prose chains don't validate, which
makes a mismatch *silent* — a JSON string flows through `trim()` and the UI
renders raw braces. So the dangerous direction is structured-output leaking
into a prose consumer: there's no validator to catch it.

### The principle

**Every chain has exactly one output mode; the bug is a contract violation
between producer and consumer, and a tolerant parser absorbs format noise
but not a genuine mode disagreement.** Declare the mode in the prompt's
Output section, match it at the consumer, and lean on the validator to make
structured-mode mismatches loud. The silent direction — structured leaking
into prose — is the one to hunt for in review.

## Primary diagram

Producer modes, the parse seam, consumer reads, and where mismatches hide.

```
  Output mode mismatch — aptkit

  ┌─ Producers (each one mode) ─────────────────────────────────┐
  │  query agent       → PROSE                                   │
  │  recommendation    → JSON array in a fence                   │
  │  intent classifier → ONE WORD                                │
  └────────────────────────────┬──────────────────────────────────┘
                              │ output text
  ┌─ Parse seam ──────────────▼───────────────────────────────────┐
  │  parseAgentJson: strip fence → parse → scan {}/[]             │
  │     absorbs: courteous fence, prose-prefix-then-JSON          │
  │     CANNOT fix: prose-vs-JSON genuine disagreement            │
  └────────────────────────────┬──────────────────────────────────┘
                              │
  ┌─ Consumers ───────────────▼───────────────────────────────────┐
  │  prose  → finalText.trim()        (no validator → silent miss) │
  │  JSON   → validator-gated         (mismatch is LOUD)           │
  └────────────────────────────────────────────────────────────────┘
```

## Elaborate

Output-mode mismatch is a specialization of the structured-output discipline
(concept 2) applied across a chain boundary. The reason it earns its own
concept is the *silent* direction: structured-output tooling makes
JSON-mode failures loud, but nobody validates prose, so a structured value
leaking into a prose consumer passes every check and corrupts the UI. The
defense is the same one that makes single-purpose chains safe (concept 6):
the seam between stages is a typed contract, and the producer's declared mode
is part of that contract.

The repo's design quietly anticipates the most common real mismatch — the
courteous fence — by *asking* for a fenced block in the recommendation
prompt and stripping it in `parseAgentJson`. That's the production move:
don't fight the model's politeness, parse around it.

## Interview defense

**Q: What's an output-mode mismatch and how do you catch it?**

Each chain declares one output mode — prose or structured. The mismatch is
when a consumer reads the producer's output in the wrong mode: a `JSON.parse`
on prose throws, a `trim()` on JSON leaks raw braces downstream. Catch it in
review by checking the producer's Output section against the consumer's read,
and make structured outputs loud with a validator. The dangerous case is
structured leaking into a prose consumer, because there's no validator there.

```
  JSON producer ↔ prose consumer (trim) → silent garbage  ← hunt this one
  prose producer ↔ JSON consumer (parse) → loud crash
```

Anchor: "aptkit declares mode in the prompt — query agent says 'No JSON
required,' recommendation says 'Return ONLY a JSON array.' `parseAgentJson`
absorbs the courteous fence but can't fix a real mode disagreement."

**Q: A model that returned clean JSON starts wrapping it in a code fence
after an upgrade. What breaks and what saves you?**

A naive `JSON.parse` breaks on the backticks. What saves you is a tolerant
parser that strips the fence before parsing — `parseAgentJson` matches a
` ```json ` fence, falls back to a substring scan for the outermost braces.
The deeper save is having declared the mode and tested it, so the regression
shows up in the eval suite, not in production.

Anchor: "Courteous fence after an upgrade — `parseAgentJson` strips it; the
eval suite catches the drift."

## See also

- [02-structured-outputs.md](02-structured-outputs.md) — the tolerant parse
  and validator this depends on
- [06-single-purpose-chains.md](06-single-purpose-chains.md) — the typed
  contract at the stage seam
- [09-chain-of-thought.md](09-chain-of-thought.md) — putting reasoning in a
  field so it doesn't pollute the output mode
