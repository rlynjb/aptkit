# Reproduction spike harness — quantifying a risky assumption before you build on it

**Industry names:** de-risking spike · reliability harness · reproduction script · pre-flight check. **Type:** Project-specific (the *shape* — run-N-times-and-measure — is language-agnostic).

## Zoom out, then zoom in

Before this session, every observability mechanism in AptKit read *backwards* from a run that already happened — open the artifact, read the trace, see what the agent did. This pattern runs *forward*: it asks a yes/no question about a component you haven't built yet, runs it N times, and prints a pass-rate verdict. It's evidence-gathering as a pre-condition for building, not a post-mortem.

Here's where it sits — it's the only box in this guide that runs *outside* the agent loop entirely, talking straight to the provider:

```
  Zoom out — where the spike harness lives

  ┌─ Scripts layer (scripts/) ──────────────────────────────────┐
  │  ★ gemma-toolcall-spike.mjs ★   ← we are here                │
  │     loop N times → call provider → decode → tally → verdict  │
  └───────────────────────────┬─────────────────────────────────┘
                              │ HTTP POST /api/chat (bypasses the agent loop)
  ┌─ Provider (Ollama, local) ▼─────────────────────────────────┐
  │  gemma2:9b  → messy text reply                               │
  └───────────────────────────┬─────────────────────────────────┘
                              │ raw string
  ┌─ Runtime (the ONE real import) ▼────────────────────────────┐
  │  parseAgentJson(raw)  → the exact decode package A relies on │
  └──────────────────────────────────────────────────────────────┘
```

Notice what it does *not* touch: no `runAgentLoop`, no `CapabilityEvent` stream, no artifact, no tool registry. It imports exactly one project symbol — `parseAgentJson` (`scripts/gemma-toolcall-spike.mjs:23`) — the one piece whose reliability the whole personal-agent project bets on. Everything else is inlined so the harness can't pass for the wrong reason.

Zoom in: the pattern is a **measurement loop over a non-deterministic component.** The riskiest assumption in the new self-hosted agent stack is that Gemma2:9b — a model with *no native tool-calling* — can be *prompted* to print a tool call as JSON reliably enough to build on. You can't reason your way to that answer; the model is a coin you have to flip. So you flip it N times and count.

## The structure pass

**Layers.** Three: the harness (the loop + the verdict), the provider under test (Ollama/Gemma over HTTP), and the one borrowed decode function. Hold one axis constant across them — **trust**: how much do you believe the next layer down?

```
  Axis = "how much do we trust this layer's output?"  — traced down

  ┌──────────────────────────────────────┐
  │ harness loop                          │  → trusts NOTHING; it measures
  └──────────────────────────────────────┘
      ┌──────────────────────────────────┐
      │ Gemma over HTTP                   │  → trusted 0% (it's the unknown)
      └──────────────────────────────────┘
          ┌──────────────────────────────┐
          │ parseAgentJson               │  → trusted 100% (already tested)
          └──────────────────────────────┘

  the trust answer FLIPS hard at each seam — that contrast is the whole design
```

**The load-bearing seam** is between "Gemma over HTTP" (trust = 0) and `parseAgentJson` (trust = 1). The spike exists to *measure exactly that seam*: given Gemma's untrusted messy output, how often does the trusted decoder produce a clean `ModelToolUseBlock`? That single number — the pass rate across the seam — is the entire output of the tool. The harness is the instrument that reads it.

Hand off to How it works with the skeleton named: a loop that crosses an untrusted→trusted seam N times and tallies the crossing.

## How it works

#### Move 1 — the mental model

You already know the shape of a flaky-test re-run: run the same test 20 times, count how many pass, decide if it's stable. This is that, pointed at a model instead of a test. The component under test is non-deterministic, so a single run tells you nothing — `1/1 pass` and `0/1 pass` are both noise. Only the *distribution over N* is signal.

```
  The measurement-loop kernel

  for i in 1..N:
      raw    = callGemma()           ← the non-deterministic step
      result = decode(raw)           ← the trusted transform
      if result.ok:  pass += 1
      else:          record(failure, raw)   ← keep the EVIDENCE
  ────────────────────────────────────
  rate = pass / N   →   verdict(rate)       ← turn the number into a decision
```

The kernel is four parts, and each is load-bearing in a way you only notice when it's missing.

#### Move 2 — the walkthrough

**The loop bound `N`.** You know how a single benchmark run can lie? Same here. `RUNS` defaults to 10 and is a CLI arg (`--runs 20`). N is what converts a coin-flip into a rate. Drop it to 1 and the harness is back to anecdote — "it worked when I tried it" — which is exactly the false confidence the spike exists to kill. *What breaks without it:* you measure luck, not reliability.

**The fail-fast pre-check.** Before the loop, the harness makes *one* call and bails with a human message if Ollama isn't reachable (`scripts/gemma-toolcall-spike.mjs:124-131`: "Cannot reach Gemma. Is the model pulled and Ollama running?"). This separates "the model is unreliable" (the thing you're measuring) from "your environment is broken" (noise). *What breaks without it:* a connection error gets counted as a parse failure and poisons the rate.

**The two-tier tally.** The harness counts *two* bars, not one (`:133-156`):

```
  Two bars, because "failed" has two very different meanings

  parseable      = parseAgentJson found JSON at all      (the LOW bar)
       │
       ▼  of those, how many were a clean, correctly-named tool call?
  validToolUse   = right tool, object args, decodes clean (the REAL bar)

  the GAP between them tells you WHERE it's failing:
    low parseable      → Gemma emits prose/markdown, not JSON  → prompt problem
    parseable high,
    validToolUse low   → JSON but wrong shape/tool             → schema problem
```

That gap is the diagnostic payload. One number ("80% works") tells you whether to proceed; the *two* numbers tell you *what to fix* if it doesn't. *What breaks without the split:* a 50% score is unactionable — you don't know if the prompt or the schema is the culprit.

**Kept failures with raw output.** Every failure pushes `{ i, reason, raw }` and the harness prints the raw model text at the end (`:163-169`). This is the observability move: a rate without the failing samples is a thermometer with no diagnosis. When you see `wrong tool name "get_current_weather"` next to the raw text, you know the prompt needs to pin the exact name. *What breaks without it:* you know it's 60% but have no thread to pull to make it 90%.

**The verdict, banded.** The rate maps to a three-way decision (`:171-185`): `≥0.8` GREEN-LIGHT, `0.4–0.8` SHAKY (build it, but wrap generation in a parse-retry loop), `<0.4` RISK (try a stricter prompt or a different model). This is the spike's whole reason to exist — it doesn't just report a number, it converts the number into "build it / harden it / abandon it." *What breaks without it:* you have data and still have to argue about what it means.

#### Move 2.5 — current vs future state

This is a **throwaway** by design — the file's own header says "delete after package A is green" (`:1`). That's the lifecycle to understand:

```
  Phase A: the spike (NOW, in scripts/)   Phase B: the real provider (SHIPPED)
  ──────────────────────────────────      ─────────────────────────────────────
  inline decode, prints a rate            GemmaModelProvider.complete()
  one import (parseAgentJson)             same parseAgentJson, now in parseToolCall
  no retry — just MEASURES retry-need     RETRY_NUDGE loop, maxToolCallAttempts: 2
  answers "is this buildable?"            IS the thing the spike green-lit
```

The spike's SHAKY-band advice — "wrap generation in a 1–2x parse-retry loop" — became `gemma-provider.ts:62-89`: the `maxToolCallAttempts` loop that re-prompts with `RETRY_NUDGE` when the reply looks like a botched tool call. The spike measured the need; the provider implements the fix. Once the provider's fixture tests are green, the spike has done its job and can be deleted. *The takeaway is what didn't have to change:* `parseAgentJson` is identical in both — the spike proved the decoder before a line of the provider existed.

#### Move 3 — the principle

When a component is non-deterministic, *measure the distribution before you design around it.* A reproduction spike is the cheapest possible experiment: one file, one import, an hour of runtime, and it answers a go/no-go question that would otherwise cost you a half-built package to discover. The discipline is to make the spike measure exactly one seam (here: messy-text → clean-tool-call) and inline everything else, so a green result can't be a false positive.

## Primary diagram

The whole harness in one frame — loop, seam, two-tier tally, verdict.

```
  gemma-toolcall-spike.mjs — measure one seam N times, then decide

  ┌─ Scripts layer ─────────────────────────────────────────────────────┐
  │                                                                      │
  │  pre-check: one callGemma() — fail fast if Ollama down  (:124-131)   │
  │                                                                      │
  │  for i in 1..N (:137):                                               │
  │     ┌──────────────┐  HTTP   ┌─ Provider ──┐  raw text               │
  │     │ callGemma()  │ ──────► │ gemma2:9b   │ ─────────┐              │
  │     └──────────────┘ /api/chat└─────────────┘          ▼              │
  │                                            ┌─ decodeToolUse (:89) ──┐ │
  │                                            │ parseAgentJson(raw)    │ │
  │                                            │ → ok? right tool?      │ │
  │                                            └──────────┬─────────────┘ │
  │            parseable += 1 ◄── found JSON              │ ok            │
  │            validToolUse += 1 ◄── clean tool call ◄────┘               │
  │            else: failures.push({ i, reason, raw })  ← evidence kept   │
  │                                                                      │
  │  rate = validToolUse / N  →  GREEN ≥.8 / SHAKY ≥.4 / RISK  (:171-185)│
  └──────────────────────────────────────────────────────────────────────┘
```

## Implementation in codebase

**Use cases.** Exactly one, and it's the reason the file exists: before scaffolding `@aptkit/provider-gemma`, prove that prompted tool-call emulation on Gemma2:9b is reliable enough to build on. The personal-agent design doc (`docs/personal-agent-packages.md`) calls this "the hard part" of package A. Rather than build the package and *then* discover the model can't hold the JSON contract, the spike de-risks it in an hour. Run it with `node scripts/gemma-toolcall-spike.mjs` (after `ollama pull gemma2:9b`).

**Code side by side.**

```
  scripts/gemma-toolcall-spike.mjs  (the tally + verdict, lines 133–185)

  let parseable = 0;                    ← low bar: did we get JSON at all?
  let validToolUse = 0;                 ← real bar: clean, correctly-named call
  const failures = [];                  ← evidence: every miss + its raw text

  for (let i = 0; i < RUNS; i += 1) {   ← N flips of the coin
    raw = await callGemma();            ← the non-deterministic step
    const result = decodeToolUse(raw, i);
    if (!reason.startsWith('parseAgentJson threw')) parseable += 1;  ← tier 1
    if (result.ok) { validToolUse += 1; '.' }        ← tier 2 (the one that matters)
    else { failures.push({ i, reason, raw }); 'x' }   ← keep the sample
  }

  const rate = validToolUse / RUNS;
  if (rate >= 0.8)      → GREEN-LIGHT package A          ← build it as-is
  else if (rate >= 0.4) → SHAKY: wrap in parse-retry loop ← build it, harden it
  else                  → RISK: stricter prompt / other model ← don't commit yet
       │
       └─ the banding is the load-bearing line: it turns a float into a
          go / harden / no-go decision. A rate with no band is just a number.
```

```
  scripts/gemma-toolcall-spike.mjs  (decodeToolUse, lines 89–113)

  parsed = parseAgentJson(raw);         ← the ONE trusted import (the seam)
  const name  = parsed.tool ?? parsed.name ?? parsed.tool_name;   ← tolerant of
  const input = parsed.arguments ?? parsed.input ?? parsed.args;  ← shape drift
  if (typeof name !== 'string')   return { ok:false, reason:'no string tool name' };
  if (typeof input !== 'object')  return { ok:false, reason:'no object arguments' };
  if (name !== TOOL.name)         return { ok:false, reason:`wrong tool name "${name}"` };
  return { ok: true, block };
       │
       └─ the ?? chains mirror gemma-provider.ts:177-178 exactly — the spike
          decodes the same way the real provider will, so a GREEN result
          actually predicts the provider's behavior (no false positive)
```

The `?? ?? ` fallback chains are not incidental — they're identical to `parseToolCall` in `gemma-provider.ts:177-178`. That's what makes the spike's verdict *transferable*: it decodes Gemma's output the same way production will, so an 80% in the spike is an honest forecast of 80% in the provider.

## Elaborate

The spike is a *vertical slice de-risk* — a tracer-bullet idea from "The Pragmatic Programmer," narrowed to a single risky assumption. The discipline that makes it work is **measuring the riskiest unknown first, in isolation, cheaply.** It's adjacent to chaos engineering (deliberately probing a failure mode) and to property-based testing (running many trials to find the distribution), but its purpose is a *build decision*, not a regression guard.

The contrast with the rest of this guide is the lesson: the replay artifact (`02-replay-artifact-as-snapshot.md`) is observability *after* a run, the eval verdict (`06-eval-as-embedded-evidence.md`) is correctness *of* a run, and this spike is reliability evidence *before the code that runs even exists.* All three are "gather evidence, then decide" — the spike just runs first in the timeline.

## Interview defense

**Q: How do you decide whether a flaky LLM component is reliable enough to build on?**
Don't reason about it — measure it. Run the exact risky path N times, count clean successes, and band the rate into a decision: green-light, harden-with-retry, or abandon. The load-bearing detail people forget is **keeping the failing samples with their raw output** — a pass rate alone tells you *whether* to proceed; the failures tell you *what to fix* to raise it.

```
  the answer in one picture

  flaky component → run N times → rate → BAND → decision
                         │                 │
                    keep failures     ≥.8 build / ≥.4 harden / <.4 no-go
                    (the "what to fix")
```

**Anchor:** "I'd write a one-import spike like `gemma-toolcall-spike.mjs` — flip the coin 20 times, report parseable vs clean-tool-call as two bars so I know if the prompt or the schema is broken, and band the result into build/harden/no-go."

**Q: Why two counters instead of one pass/fail?**
Because "failed" hides two different root causes. `parseable` low means Gemma emitted prose or markdown — a *prompt* problem. `parseable` high but `validToolUse` low means it emitted JSON of the wrong shape — a *schema* problem. The gap between the bars points straight at the fix. One bar makes a 50% score unactionable.

## Validate

1. **Reconstruct:** From memory, write the four-part kernel of the measurement loop (`scripts/gemma-toolcall-spike.mjs:137-156`) and name what breaks if you drop N, the fail-fast pre-check, the failure-with-raw capture, and the verdict band.
2. **Explain:** Why does the spike import only `parseAgentJson` (`:23`) and inline everything else? (So a green result can't pass for the wrong reason.) Why do the `?? ?? ` chains at `:99-100` matter? (They match `gemma-provider.ts:177-178`, making the forecast honest.)
3. **Apply:** The spike reports `parseable 9/10, validToolUse 4/10`. Which layer is broken — prompt or schema — and what's your next move? (Schema/shape: JSON parses but the tool name or args are wrong. Tighten the shape instruction / add a few-shot example, not the "emit JSON" instruction.)
4. **Defend:** A teammate says "just try it once, it worked for me." Argue why N matters here and why the SHAKY band (`:177-180`) still green-lights building — as long as you add the retry loop that became `gemma-provider.ts:62-89`.

## See also

- `01-structured-trace-events.md` — once the provider is built, *its* runs emit the `CapabilityEvent` stream; the spike is the pre-flight before that stream exists.
- `08-retrieval-miss-diagnosis.md` — the post-build counterpart: a bug the spike *couldn't* catch (it tests tool emission, not retrieval correctness), found later by reading the trajectory.
- `06-eval-as-embedded-evidence.md` — the spike measures reliability before building; the eval measures correctness after.
- `study-ai-engineering` — Gemma provider, prompted tool-call emulation, the parse-retry pattern.
- `study-testing` — the fixture tests that the spike green-lights writing.
