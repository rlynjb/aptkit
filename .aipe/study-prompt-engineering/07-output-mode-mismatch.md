# 07 — Output mode mismatch

**Industry name:** output-format contract mismatch — *Project-specific / Language-agnostic*

## Zoom out, then zoom in

This is the bug that ships green and breaks in prod: chain A is tuned to return
JSON, chain B downstream expects markdown prose, and the parser between them
explodes on the first real call. Or subtler — an agent declared as "answer in
plain text" gets a prompt edit that makes it emit a JSON object, and the
plain-text consumer chokes. **Every chain has exactly one output mode, declared
in its prompt, and the consumer must agree with that declaration.** When they
disagree, the seam breaks.

```
  Zoom out — the three output modes in this repo

  ┌─ Producers (each declares ONE mode) ──────────────────────┐
  │  classifyIntent   → MODE: bare text (one word)            │ ← we are here
  │  query-agent      → MODE: plain prose ("No JSON required")│
  │  diagnostic-agent → MODE: JSON in a ```json fence         │
  │  Gemma tool call  → MODE: {"tool":...,"arguments":...}    │
  └───────────────────────────┬────────────────────────────────┘
                              │  consumed by ↓
  ┌─ Consumers (must match the mode) ─▼────────────────────────┐
  │  parseIntent (string)  ·  parseAgentJson (JSON)  ·          │
  │  return finalText (prose)  ·  parseToolCall (tool JSON)     │
  └──────────────────────────────────────────────────────────────┘
```

Zoom in: the failure is always at the producer→consumer seam, and the fix is
always the same — make the prompt's declared mode and the parser's expectation
the same thing, and spot the divergence in code review.

## The structure pass

**Layers:** the prompt's output contract (declared mode) → the model's emission →
the consumer's parser (expected mode).

**Axis — what shape does this layer expect?** When the answer flips across the
seam without anyone noticing, that's the bug:

```
  Axis: "what output shape?" — must hold across the seam

  ┌─ Producer (prompt) ─┐   seam    ┌─ Consumer (parser) ─┐
  │ declares: prose     │ ══╪══════► │ expects: prose      │  ✓ match
  │ declares: JSON fence│ ══╪══════► │ expects: JSON        │  ✓ match
  │ declares: prose     │ ══╪══════► │ expects: JSON  ⚠     │  ✗ MISMATCH
  └─────────────────────┘            └──────────────────────┘
   the mode must NOT flip across the seam — if it does, parser breaks
```

**Seam:** the parse call right after generation. `parseIntent` (`intent.ts:4`)
expects a bare word; `parseAgentJson` (`json-output.ts:7`) expects JSON;
`RagQueryAgent.answer` returns `finalText.trim()` (`rag-query-agent.ts:82`) and
expects prose. **What breaks if the producer's mode flips:** add "return your
reasoning as JSON" to the query agent's prompt and `finalText` is now a JSON
blob handed to a prose consumer — no error, just garbage rendered to the user.

## How it works

### Move 1 — the mental model

You already enforce this with TypeScript: a function declares its return type and
the caller relies on it; change the return type without changing the caller and
the compiler screams. An LLM chain has the same contract *except there's no
compiler* — the "return type" is a sentence in the prompt and the "caller" is a
parser, and nothing forces them to agree. You enforce it by convention and by
review.

```
  Pattern — output mode as an untyped contract

  PROMPT says: "<mode>"  ───(no compiler)───►  PARSER assumes: "<mode>"
                                              │
  if these two strings disagree, the failure is silent until runtime
```

### Move 2 — walking the modes

**Mode A — bare text.** The intent classifier's prompt: *"Reply with ONLY the one
word"* (`intent.ts:19`). Its consumer `parseIntent` (`intent.ts:4`) lowercases
and substring-matches `monitoring`/`recommendation`/`diagnostic`, defaulting to
`diagnostic`. The mode is "a short string"; the parser is forgiving of
surrounding text. **The boundary done right:** the parser tolerates the model
saying "diagnostic." with a period — it `includes`-matches rather than
equality-checks.

**Mode B — JSON in a fence.** The diagnostic prompt: *"Return ONLY a JSON object
in a ```json fenced block with this shape"* (`diagnostic.ts:28`). The consumer is
`parseAgentJson` (`json-output.ts:7`), which strips the fence and parses. Producer
and consumer agree: one declares the fence, the other strips it. **What breaks if
they disagree:** if the prompt said "return JSON" without "fence" and the model
fenced it anyway, a naive `JSON.parse` would fail — which is exactly why
`parseAgentJson` defends both cases (concept 02).

**Mode C — plain prose.** The query agent: *"No JSON shape is required - just the
answer text"* (`query.ts:48`). Its consumer takes `finalText` directly. There's
*intentionally* no parser. **The mismatch risk:** this is the most fragile,
because a prompt edit that nudges the model toward structure has no parser to
fail loudly — it just degrades the rendered output.

**Mode D — emulated tool call.** Gemma's `buildSystemText` declares
*"respond with ONLY a single JSON object: {"tool": ..., "arguments": ...}"*
(`gemma-provider.ts:157`); `parseToolCall` (`:168`) expects exactly that shape
and tolerates `tool`/`name`/`tool_name` and `arguments`/`input`/`args` aliases.
The mode is a *specific* JSON contract, and the parser is built to its
declaration.

**How to spot a mismatch in review.** Two things must line up in the same PR:
the prompt's output sentence (`## Output` section) and the parser at the call
site. If a diff touches one without the other, that's the smell. The repo's
defense-in-depth is `parseAgentJson` being tolerant — but tolerance hides
mismatches, so it's not a substitute for the contract being right.

### Move 3 — the principle

**An output mode is a contract with no compiler — so the discipline is to keep
the declaration and the parser in the same line of sight.** The bug is never that
the model "got it wrong"; it's that two humans changed the prompt and the parser
independently. Treat a prompt's `## Output` section as the function signature and
review it against the consumer every time either moves.

## Primary diagram

```
  Output mode mismatch — producer/consumer agreement table

  PRODUCER (prompt declares)          CONSUMER (parser expects)     match?
  ─────────────────────────────────   ───────────────────────────   ──────
  intent: "ONLY one word"             parseIntent (substring)        ✓
  diagnostic: "JSON in ```json fence" parseAgentJson (fence-strip)   ✓
  query: "plain prose, no JSON"        finalText (no parse)          ✓
  gemma: '{"tool":...,"arguments":}'  parseToolCall (shape+aliases)  ✓

  a prompt edit that flips a PRODUCER mode without updating the
  CONSUMER turns a ✓ into a silent ✗
```

## Elaborate

This is the operational sibling of concept 02 (structured outputs) and concept 07
of the broader "contracts at the LLM boundary" idea. The reason it deserves its
own concept: structured-output tooling solves the *enforcement* of a mode, but
mode *mismatch* is a coordination failure between two parts of your system, which
no single tool catches. The mitigation in mature codebases is to type the handoff
(concept 06's typed handoffs) so the consumer's expectation is a real type, not a
parser convention — this repo does that for the agent handoffs (`{diagnosis}` is
a validated shape) but the prose modes (query agent) remain convention-only,
which is the honest fragile spot.

## Interview defense

**Q: A chain that worked starts producing garbage downstream — where do you
look?** The output-mode seam: did the producer's prompt change its declared
format (prose ↔ JSON ↔ tool call) without the consuming parser changing to
match? It ships green because there's no compiler on the prompt's "return type."

```
  prompt ## Output  ──must equal──  parser expectation
  flip one in a PR, not the other → silent mismatch
```
*Anchor: `query.ts:48` (prose) vs `diagnostic.ts:28` (JSON fence) vs
`parseAgentJson` (`json-output.ts:7`).*

**Q: The part people forget?** The **prose mode has no parser to fail loudly**.
JSON mismatches at least throw; a prompt that drifts the query agent toward
structure just renders worse, undetected. The fix is to treat the `## Output`
section as a signature reviewed against its consumer.

## See also

- `02-structured-outputs.md` — enforcing a JSON mode and parsing it tolerantly.
- `06-single-purpose-chains.md` — typed handoffs make the consumer's expectation a type.
- `01-anatomy.md` — the `## Output` section is the mode declaration.
