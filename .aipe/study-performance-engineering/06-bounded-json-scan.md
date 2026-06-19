# Bounded JSON Scan

*Industry names: bounded parse, lenient extraction with a hard ceiling,
no-backtracking recovery. Type: Industry standard (defensive parsing).*

## Zoom out, then zoom in

Models don't always return clean JSON — they wrap it in prose, fences, or
trailing chatter. You have to dig the JSON out, but the digging itself can
become an unbounded-work trap (regex backtracking, parse-retry loops). This
pattern extracts the JSON with a *fixed, small* number of attempts and then
gives up — so a malformed model output costs microseconds, not a hang.

```
  Zoom out — where the scan sits

  ┌─ Agent layer ──────────────────────────────────────┐
  │  parseResult(finalText) → tryParseRecommendations   │ ← we are here (caller)
  └──────────────────────────┬──────────────────────────┘
                            │  raw model text in
  ┌─ Runtime layer ─────────▼───────────────────────────┐
  │  ★ parseAgentJson ★  fence → parse → bounded slice  │ ← we are here
  └──────────────────────────┬──────────────────────────┘
                            │  parsed value or one throw
  ┌─ Validator ─────────────▼───────────────────────────┐
  │  shape check → typed result or recovery turn         │
  └──────────────────────────────────────────────────────┘
```

Zoom in: it's three attempts in a fixed order — strip a fenced block, try
one `JSON.parse`, then try one slice from the first bracket to the last —
and if none work, throw. No loop, no backtracking, no retry-on-retry.

## The structure pass

**Layers:** agent (asks for a parsed shape) → runtime scan (extracts) →
validator (checks the shape).

**Axis — work done on bad input:** how much CPU does a *malformed* output
cost? Trace it through the scan.

```
  One axis — "what does a malformed model output cost to reject?"

  ┌─ naive: loop/regex-backtrack ───┐   ┌─ bounded scan ──────────────────┐
  │ retries, catastrophic regex     │   │ at most 3 fixed attempts        │
  │ → unbounded, can hang           │   │ → constant work, then throw     │
  └──────────────────────────────────┘   └──────────────────────────────────┘
```

**The seam that matters:** the boundary between "extract" and "give up."
After a fixed number of attempts the scan stops trying and throws — that
throw is what converts a potentially-unbounded recovery into a bounded one,
and it hands control to the validator/recovery path instead of spinning.

## How it works

You know how you'd pull a number out of a messy string — try the clean
parse first, then fall back to a single targeted extraction, and if that
fails, bail rather than try ten more heuristics? That's exactly this. The
discipline is that the fallback ladder has a *fixed length*: each rung is
tried once, in order, and the bottom rung is a throw.

### Move 1 — the mental model: a three-rung ladder, then throw

```
  The kernel — fixed-length fallback ladder

  text
   │  rung 1: regex out a ```json fenced block (if present)
   ▼
  candidate
   │  rung 2: JSON.parse(candidate)  ── success ──► return
   ▼ (fail)
   │  rung 3: slice from first {/[ to last }/], JSON.parse that
   ▼ success ──► return
   │ (no brackets, or still fails)
   ▼
  throw "no parseable json"   ◄── the bottom rung; no more attempts
```

### Move 2 — the step-by-step walkthrough

**Rung 1 — strip the fence (cheap normalize).** A single regex pulls the
inside of a ```` ```json … ``` ```` block if one exists; otherwise the whole
text is the candidate. Bridge from what you know: it's a `.trim()`-style
normalize step — one pass, no backtracking risk because it's a single
non-greedy match. This handles the common case where the model politely
fenced its JSON.

```
  Rung 1 — fence strip

  text.match(/```(?:json)?\s*([\s\S]*?)```/i)
       │ matched?  → candidate = inside the fence
       │ no match? → candidate = whole text
       ▼ .trim()
```

**Rung 2 — try one clean parse.** `JSON.parse(candidate)`. If the candidate
is valid JSON (the fence held clean JSON, or the model returned bare JSON),
this returns immediately. One attempt. Bridge: the happy path — try the
thing you actually want before any salvage logic.

**Rung 3 — one bounded substring slice.** If the clean parse threw, find the
first `{` or `[` and the last `}` or `]`, and parse exactly that slice. This
salvages JSON with leading/trailing prose ("Here's the answer: {…} hope that
helps"). The load-bearing word is *bounded*: it's `indexOf` + `lastIndexOf`
+ one `slice` + one `JSON.parse` — four constant operations, no loop. Drop
the bounding and the tempting alternative is "scan for every balanced-bracket
substring," which is where parsing recovery code goes quadratic or worse.

```
  Rung 3 — first bracket to last bracket, once

  start = min(indexOf('{'), indexOf('['))   ← first opener
  end   = max(lastIndexOf('}'), lastIndexOf(']'))  ← last closer
  if start >= 0 and end > start:
     return JSON.parse(candidate.slice(start, end + 1))   ← ONE parse of the slice
```

**The throw — the bottom rung (what makes it bounded).** If there are no
brackets, or the slice still doesn't parse, the scan throws `no parseable
json in model output`. It does *not* try more heuristics. Bridge: it's the
final `return null`/`throw` after a fixed fallback chain — the thing that
guarantees the function terminates in constant time regardless of input.
The caller (`parseValidatedJson`) catches the throw and turns it into an
`{ ok: false }`, which upstream can route into the agent's one-shot recovery
turn (**01-turn-and-tool-budget.md**) — but the *scan* itself never loops.

```
  The throw — termination guarantee

  start < 0 OR end <= start OR slice fails
     → throw 'no parseable json in model output'
        │
        └─ no rung 4, 5, 6... — constant work, then done
```

### Move 3 — the principle

**A recovery path needs a ceiling as much as the happy path needs to be
correct.** Lenient parsing is good — you want to salvage a JSON object
buried in prose — but "lenient" must not mean "unbounded." A fixed ladder
of attempts ending in a throw gives you both: it recovers the common messy
cases *and* it can't be turned into a CPU sink by adversarial or garbage
input. The general lesson: every salvage routine should answer "what's the
worst-case work on input designed to defeat me?" — and the answer should be
a constant.

## Primary diagram

The full ladder, with the bound marked.

```
  Bounded JSON scan — full recap

  ┌─ Runtime: parseAgentJson(text) ───────────────────────────┐
  │                                                           │
  │  rung 1: candidate = fenced block ?? whole text (.trim)   │
  │                                                           │
  │  rung 2: try JSON.parse(candidate) ──── ok ──► return     │
  │             │ catch                                       │
  │  rung 3: start = first {/[ ; end = last }/]               │
  │          start>=0 && end>start ?                          │
  │             JSON.parse(slice(start, end+1)) ── ok ──► return│
  │             │                                             │
  │  bottom: throw 'no parseable json'  ◄── constant-time bail │
  └───────────────────────────────┬────────────────────────────┘
                                  ▼ caught by parseValidatedJson → {ok:false}
                          → optional one-shot recovery turn (the loop)
```

## Implementation in codebase

**Use cases.** Every agent that returns structured output runs its
`finalText` through this: recommendation parses a JSON array
(`recommendation-agent.ts:91`), monitoring/diagnostic/rubric parse objects.
Models frequently wrap JSON in a fence or add a sentence before it; this is
the routine that gets the data out without the agent code caring how the
model formatted it.

**Code — the three-rung scan, `packages/runtime/src/json-output.ts:7-28`:**

```
export function parseAgentJson(text: string): unknown {
  const fence = text.match(/```(?:json)?\s*([\s\S]*?)```/i);   ← rung 1: non-greedy fence
  const candidate = (fence ? fence[1] : text).trim();

  try {
    return JSON.parse(candidate);                              ← rung 2: one clean parse
  } catch {
    // Fall through to a bounded substring scan.
  }

  const objectStart = candidate.indexOf('{');                 ← rung 3: first opener
  const arrayStart = candidate.indexOf('[');
  const starts = [objectStart, arrayStart].filter((index) => index >= 0);
  const start = starts.length > 0 ? Math.min(...starts) : -1;
  const end = Math.max(candidate.lastIndexOf('}'), candidate.lastIndexOf(']'));  ← last closer

  if (start >= 0 && end > start) {
    return JSON.parse(candidate.slice(start, end + 1));        ← ONE parse of the slice
  }

  throw new Error('no parseable json in model output');        ← bottom rung: constant-time bail
       │
       └─ no loop, no backtracking — worst-case work on garbage input is a constant
}
```

**Code — the caller that turns a throw into a result,
`packages/runtime/src/json-output.ts:30-45`:**

```
export function parseValidatedJson<T>(text: string, validate: JsonValidator<T>): JsonValidation<T> {
  let parsed: unknown;
  try {
    parsed = parseAgentJson(text);                             ← bounded scan
  } catch (error) {
    return { ok: false, error: ... };                          ← throw → {ok:false}, no retry here
  }
  return validate(parsed);                                     ← shape check after extraction
}
```

## Elaborate

This is defensive parsing with a deliberate work ceiling — the same
instinct behind avoiding catastrophic-backtracking regexes or capping a
recovery loop's iterations. The interesting restraint is what it *doesn't*
do: no balanced-bracket scanner, no per-character state machine, no
multiple slice attempts. The first-opener-to-last-closer slice is a single
heuristic that handles the overwhelmingly common "prose then JSON then
prose" case and explicitly accepts that it'll fail on pathological nesting —
at which point the throw routes to the agent's recovery turn, which is a
better place to spend a (bounded) retry than inside the parser. It pairs
with the turn budget (**01-turn-and-tool-budget.md**), whose recovery turn
is the bounded retry this scan's throw can trigger. For the runtime
execution model around it, see **study-runtime-systems**.

## Interview defense

**Q: Models return messy JSON. How do you extract it without risking an
unbounded parse?**

A fixed three-rung ladder: strip a fenced block, try one clean parse, then
try one slice from the first bracket to the last. If none work, throw —
there's no fourth attempt. Worst-case work on garbage input is constant,
because there's no loop and no backtracking.

```
  fence → parse → slice(first {/[ … last }/]) → throw
  (3 attempts, then bail)
```

Anchor: `json-output.ts:7-28`.

**Q: Why not scan for every balanced-bracket substring to be more robust?**

Because that's where parse-recovery code goes quadratic and becomes a CPU
sink on adversarial input. The single first-to-last slice handles the
common "prose around JSON" case in constant time; the rare pathological
case throws and routes to the agent's one bounded recovery turn — a better
place for a retry than inside the parser.

Anchor: `json-output.ts:17-27`.

## Validate

1. **Reconstruct:** write the three rungs from memory — fence, parse,
   bounded slice, throw. Check `json-output.ts:7-28`.
2. **Explain:** why is the substring scan "bounded"? (It's `indexOf` +
   `lastIndexOf` + one `slice` + one `parse` — constant operations, no loop.)
3. **Apply:** the model returns `Sure! [ {…}, {…} ] — let me know.` Which
   rung extracts the array, and how? (Rung 3: first `[` to last `]`,
   one slice + parse.)
4. **Defend:** a teammate wants to add a fourth rung that tries balanced-
   bracket matching. What does that risk, and where should the retry live
   instead? (Unbounded/quadratic work on bad input; the retry belongs in
   the agent's bounded recovery turn, `run-agent-loop.ts:204-228`.)

## See also

- **01-turn-and-tool-budget.md** — the recovery turn this scan's throw triggers.
- **05-streaming-for-perceived-latency.md** — the NDJSON decoder, another
  bounded-work guard in the runtime.
- **audit.md** — lens 4 (CPU/allocation, bounded work).
- **study-runtime-systems** — the runtime execution model.
